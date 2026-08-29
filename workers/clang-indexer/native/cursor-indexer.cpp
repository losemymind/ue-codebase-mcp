#include <clang-c/Index.h>

#include <algorithm>
#include <cctype>
#include <cwctype>
#include <filesystem>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace fs = std::filesystem;

namespace {

struct Options {
  fs::path source;
  fs::path workspace_root;
  std::vector<std::string> clang_arguments;
};

std::string TakeString(CXString value) {
  const char* encoded = clang_getCString(value);
  std::string result = encoded == nullptr ? "" : encoded;
  clang_disposeString(value);
  return result;
}

std::string Json(std::string_view value) {
  std::string output;
  output.reserve(value.size() + 2);
  output.push_back('"');
  static constexpr char Hex[] = "0123456789abcdef";
  for (const unsigned char character : value) {
    switch (character) {
      case '"': output += "\\\""; break;
      case '\\': output += "\\\\"; break;
      case '\b': output += "\\b"; break;
      case '\f': output += "\\f"; break;
      case '\n': output += "\\n"; break;
      case '\r': output += "\\r"; break;
      case '\t': output += "\\t"; break;
      default:
        if (character < 0x20) {
          output += "\\u00";
          output.push_back(Hex[character >> 4]);
          output.push_back(Hex[character & 0x0f]);
        } else output.push_back(static_cast<char>(character));
    }
  }
  output.push_back('"');
  return output;
}

std::wstring Folded(const fs::path& value) {
  std::wstring result = fs::weakly_canonical(value).native();
  std::transform(result.begin(), result.end(), result.begin(), [](wchar_t character) { return static_cast<wchar_t>(::towlower(character)); });
  return result;
}

bool IsBelow(const fs::path& root, const fs::path& value) {
  std::wstring normalized_root = Folded(root);
  std::wstring normalized_value = Folded(value);
  if (!normalized_root.ends_with(L'\\')) normalized_root.push_back(L'\\');
  return normalized_value.size() > normalized_root.size() && normalized_value.starts_with(normalized_root);
}

bool IsForbiddenArgument(std::string_view value) {
  std::string lower(value);
  std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
  return lower == "-load" || lower == "-plugin" || lower == "-add-plugin" || lower == "-fplugin"
    || lower.starts_with("-fplugin=") || lower.starts_with("-fpass-plugin=") || lower.starts_with("/clang:-load")
    || lower == "-o" || lower == "-mf" || lower == "-mj" || lower == "-serialize-diagnostic-file"
    || lower == "--serialize-diagnostics" || lower == "-fmodules-cache-path" || lower.starts_with("-fmodules-cache-path=")
    || lower == "-fmodule-output" || lower.starts_with("-fmodule-output=") || lower.starts_with("-save-temps")
    || value.starts_with("/Fo") || value.starts_with("/Fe") || value.starts_with("/Fa")
    || value.starts_with("/Fi") || value.starts_with("/Fm") || value.starts_with("/FR")
    || value.starts_with("/ifcOutput") || value.starts_with("/sourceDependencies")
    || value.starts_with("/module:output");
}

Options ParseOptions(int argc, char** argv) {
  if (argc < 6 || std::string_view(argv[1]) != "--source" || std::string_view(argv[3]) != "--workspace-root") {
    throw std::runtime_error("invalid arguments");
  }
  Options options{fs::path(argv[2]), fs::path(argv[4]), {}};
  if (!options.source.is_absolute() || !options.workspace_root.is_absolute() || !fs::is_regular_file(options.source)
      || !fs::is_directory(options.workspace_root) || !IsBelow(options.workspace_root, options.source) || std::string_view(argv[5]) != "--") {
    throw std::runtime_error("invalid paths");
  }
  if (argc - 6 > 16'384) throw std::runtime_error("too many arguments");
  bool xclang = false;
  for (int index = 6; index < argc; ++index) {
    std::string value(argv[index]);
    std::string lower(value);
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
    if (value.size() > 65'536 || value.find_first_of("\r\n") != std::string::npos || IsForbiddenArgument(value)
        || (xclang && (lower == "-load" || lower == "-plugin" || lower == "-add-plugin"
            || lower == "-fmodules-cache-path" || lower == "-fmodule-output"))) {
      throw std::runtime_error("forbidden clang argument");
    }
    xclang = lower == "-xclang";
    options.clang_arguments.push_back(std::move(value));
  }
  return options;
}

std::optional<std::string> Kind(CXCursorKind kind) {
  const std::string spelling = TakeString(clang_getCursorKindSpelling(kind));
  if (spelling == "Namespace") return "namespace";
  if (spelling == "ClassDecl" || spelling == "ClassTemplate") return "class";
  if (spelling == "StructDecl") return "struct";
  if (spelling == "UnionDecl") return "union";
  if (spelling == "EnumDecl") return "enum";
  if (spelling == "EnumConstantDecl") return "enumerator";
  if (spelling == "FunctionDecl" || spelling == "FunctionTemplate") return "function";
  if (spelling == "CXXMethod") return "method";
  if (spelling == "Constructor") return "constructor";
  if (spelling == "Destructor") return "destructor";
  if (spelling == "VarDecl") return "variable";
  if (spelling == "FieldDecl") return "field";
  if (spelling == "ParmDecl") return "parameter";
  if (spelling == "TypedefDecl") return "typedef";
  if (spelling == "TypeAliasDecl" || spelling == "TypeAliasTemplateDecl") return "type_alias";
  if (spelling == "ConceptDecl") return "concept";
  if (spelling == "macro definition") return "macro";
  return std::nullopt;
}

std::string QualifiedName(CXCursor cursor) {
  std::vector<std::string> names;
  CXCursor current = cursor;
  while (!clang_Cursor_isNull(current)) {
    const std::string name = TakeString(clang_getCursorSpelling(current));
    const std::string usr = TakeString(clang_getCursorUSR(current));
    if (!name.empty() && !usr.empty()) names.push_back(name);
    current = clang_getCursorSemanticParent(current);
  }
  std::reverse(names.begin(), names.end());
  std::string output;
  for (const std::string& name : names) {
    if (!output.empty()) output += "::";
    output += name;
  }
  return output;
}

struct Location {
  std::string file;
  unsigned line = 0;
  unsigned column = 0;
};

Location SpellingLocation(CXSourceLocation value) {
  CXFile file = nullptr;
  Location location;
  unsigned offset = 0;
  clang_getSpellingLocation(value, &file, &location.line, &location.column, &offset);
  if (file != nullptr) location.file = TakeString(clang_getFileName(file));
  return location;
}

struct Context {
  fs::path workspace_root;
  std::size_t emitted = 0;
  bool overflow = false;
};

CXChildVisitResult Visit(CXCursor cursor, CXCursor, CXClientData data) {
  auto& context = *static_cast<Context*>(data);
  const CXCursorKind cursor_kind = clang_getCursorKind(cursor);
  const std::optional<std::string> kind = Kind(cursor_kind);
  if (kind.has_value()) {
    const CXSourceRange extent = clang_getCursorExtent(cursor);
    const Location start = SpellingLocation(clang_getRangeStart(extent));
    const Location end = SpellingLocation(clang_getRangeEnd(extent));
    if (!start.file.empty() && start.line > 0 && start.column > 0 && IsBelow(context.workspace_root, fs::path(start.file))) {
      if (++context.emitted > 2'000'000) {
        context.overflow = true;
        return CXChildVisit_Break;
      }
      const std::string usr = TakeString(clang_getCursorUSR(cursor));
      const std::string name = TakeString(clang_getCursorSpelling(cursor));
      const std::string display_name = TakeString(clang_getCursorDisplayName(cursor));
      const std::string type = TakeString(clang_getTypeSpelling(clang_getCursorType(cursor)));
      const std::string result_type = TakeString(clang_getTypeSpelling(clang_getCursorResultType(cursor)));
      const std::string comment = TakeString(clang_Cursor_getRawCommentText(cursor));
      const CXCursor parent = clang_getCursorSemanticParent(cursor);
      const std::string owner_usr = clang_Cursor_isNull(parent) ? "" : TakeString(clang_getCursorUSR(parent));
      std::cout << "{\"type\":\"symbol\",\"kind\":" << Json(*kind)
                << ",\"usr\":" << (usr.empty() ? "null" : Json(usr))
                << ",\"name\":" << Json(name)
                << ",\"display_name\":" << Json(display_name)
                << ",\"qualified_name\":" << Json(QualifiedName(cursor))
                << ",\"owner_usr\":" << (owner_usr.empty() ? "null" : Json(owner_usr))
                << ",\"is_definition\":" << (clang_isCursorDefinition(cursor) ? "true" : "false")
                << ",\"file\":" << Json(start.file)
                << ",\"start_line\":" << start.line << ",\"start_column\":" << start.column
                << ",\"end_line\":" << end.line << ",\"end_column\":" << end.column
                << ",\"type_spelling\":" << Json(type)
                << ",\"result_type\":" << Json(result_type)
                << ",\"documentation\":" << (comment.empty() ? "null" : Json(comment)) << "}\n";
    }
  }
  return CXChildVisit_Recurse;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    const Options options = ParseOptions(argc, argv);
    std::vector<const char*> arguments;
    arguments.reserve(options.clang_arguments.size());
    for (const std::string& argument : options.clang_arguments) arguments.push_back(argument.c_str());
    CXIndex index = clang_createIndex(1, 0);
    if (index == nullptr) throw std::runtime_error("index creation failed");
    CXTranslationUnit unit = nullptr;
    const unsigned flags = CXTranslationUnit_DetailedPreprocessingRecord;
    const CXErrorCode error = clang_parseTranslationUnit2(index, options.source.string().c_str(), arguments.data(),
      static_cast<int>(arguments.size()), nullptr, 0, flags, &unit);
    if (error != CXError_Success || unit == nullptr) {
      clang_disposeIndex(index);
      throw std::runtime_error("translation unit parse failed");
    }
    unsigned diagnostics = clang_getNumDiagnostics(unit);
    unsigned errors = 0;
    for (unsigned index_value = 0; index_value < diagnostics; ++index_value) {
      CXDiagnostic diagnostic = clang_getDiagnostic(unit, index_value);
      if (clang_getDiagnosticSeverity(diagnostic) >= CXDiagnostic_Error) ++errors;
      clang_disposeDiagnostic(diagnostic);
    }
    std::cout << "{\"type\":\"manifest\",\"schema_version\":1,\"libclang\":"
              << Json(TakeString(clang_getClangVersion())) << ",\"diagnostic_count\":" << diagnostics
              << ",\"error_count\":" << errors << "}\n";
    Context context{options.workspace_root, 0, false};
    clang_visitChildren(clang_getTranslationUnitCursor(unit), Visit, &context);
    if (context.overflow) {
      clang_disposeTranslationUnit(unit);
      clang_disposeIndex(index);
      throw std::runtime_error("symbol record limit exceeded");
    }
    clang_disposeTranslationUnit(unit);
    clang_disposeIndex(index);
    if (!std::cout.good()) throw std::runtime_error("output failed");
    return 0;
  } catch (const std::exception&) {
    std::cerr << "clang cursor indexer failed\n";
    return 2;
  }
}
