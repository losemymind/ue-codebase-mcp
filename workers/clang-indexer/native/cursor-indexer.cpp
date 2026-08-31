#include <clang-c/Index.h>

#include <algorithm>
#include <cctype>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace fs = std::filesystem;

namespace {

struct Options {
  fs::path source;
  std::vector<fs::path> workspace_roots;
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

bool IsBelowAny(const std::vector<fs::path>& roots, const fs::path& value) {
  return std::any_of(roots.begin(), roots.end(), [&](const fs::path& root) { return IsBelow(root, value); });
}

bool IsForbiddenArgument(std::string_view value) {
  std::string lower(value);
  std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
  return lower == "-load" || lower == "-plugin" || lower == "-add-plugin" || lower == "-fplugin"
    || lower.starts_with("-fplugin=") || lower.starts_with("-fpass-plugin=") || lower.starts_with("/clang:-load")
    || lower == "-o" || lower == "-mf" || lower == "-mj" || lower == "-serialize-diagnostic-file"
    || lower == "--serialize-diagnostics" || lower == "-fmodules-cache-path" || lower.starts_with("-fmodules-cache-path=")
    || lower == "-fmodule-output" || lower.starts_with("-fmodule-output=") || lower.starts_with("-save-temps")
    || lower == "-include-pch" || lower.starts_with("-include-pch=") || lower == "-pch-through-header"
    || lower.starts_with("-pch-through-header=") || lower.starts_with("/clang:-include-pch")
    || lower.starts_with("/fo") || lower.starts_with("/fe") || lower.starts_with("/fa")
    || value.starts_with("/Fi") || lower.starts_with("/fm") || lower.starts_with("/fr")
    || lower.starts_with("/fd") || lower.starts_with("/fp") || lower.starts_with("/yc") || lower.starts_with("/yu")
    || lower.starts_with("/ifcoutput") || lower.starts_with("/sourcedependencies")
    || lower.starts_with("/module:output");
}

void ValidateArguments(std::vector<std::string>& arguments) {
  if (arguments.size() > 16'384) throw std::runtime_error("too many arguments");
  bool xclang = false;
  for (const std::string& value : arguments) {
    std::string lower(value);
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
    if (value.empty() || value.size() > 65'536 || value.find_first_of("\r\n\0") != std::string::npos || IsForbiddenArgument(value)
        || (xclang && (lower == "-load" || lower == "-plugin" || lower == "-add-plugin"
            || lower == "-fmodules-cache-path" || lower == "-fmodule-output"))) {
      throw std::runtime_error("forbidden clang argument");
    }
    xclang = lower == "-xclang";
  }
}

std::vector<std::string> ReadArgumentsFile(const fs::path& root, const fs::path& file) {
  if (!root.is_absolute() || !file.is_absolute() || !fs::is_directory(root) || !fs::is_regular_file(file) || !IsBelow(root, file)) {
    throw std::runtime_error("invalid argument file");
  }
  std::ifstream input(file, std::ios::binary | std::ios::ate);
  if (!input) throw std::runtime_error("argument file unavailable");
  const std::streamsize size = input.tellg();
  if (size < 1 || size > 8 * 1024 * 1024) throw std::runtime_error("argument file size invalid");
  input.seekg(0, std::ios::beg);
  std::string encoded(static_cast<std::size_t>(size), '\0');
  if (!input.read(encoded.data(), size) || encoded.back() != '\n' || encoded.find('\r') != std::string::npos
      || encoded.find('\0') != std::string::npos) {
    throw std::runtime_error("argument file invalid");
  }
  std::vector<std::string> arguments;
  std::size_t start = 0;
  while (start < encoded.size()) {
    const std::size_t end = encoded.find('\n', start);
    if (end == std::string::npos) throw std::runtime_error("argument file invalid");
    if (end > start) arguments.push_back(encoded.substr(start, end - start));
    else if (end + 1 != encoded.size()) throw std::runtime_error("argument file invalid");
    start = end + 1;
  }
  ValidateArguments(arguments);
  return arguments;
}

Options ParseOptions(int argc, char** argv) {
  if (argc < 6 || std::string_view(argv[1]) != "--source" || std::string_view(argv[3]) != "--workspace-root") {
    throw std::runtime_error("invalid arguments");
  }
  Options options{fs::path(argv[2]), {fs::path(argv[4])}, {}};
  int index = 5;
  while (index + 1 < argc && std::string_view(argv[index]) == "--workspace-root") {
    options.workspace_roots.emplace_back(argv[index + 1]);
    index += 2;
  }
  if (options.workspace_roots.empty() || options.workspace_roots.size() > 64 || !options.source.is_absolute()
      || !fs::is_regular_file(options.source)) {
    throw std::runtime_error("invalid paths");
  }
  std::vector<std::wstring> canonical_roots;
  canonical_roots.reserve(options.workspace_roots.size());
  for (const fs::path& root : options.workspace_roots) {
    if (!root.is_absolute() || !fs::is_directory(root)) throw std::runtime_error("invalid paths");
    const std::wstring canonical = Folded(root);
    if (std::find(canonical_roots.begin(), canonical_roots.end(), canonical) != canonical_roots.end()) {
      throw std::runtime_error("duplicate workspace root");
    }
    canonical_roots.push_back(canonical);
  }
  if (!IsBelow(options.workspace_roots.front(), options.source)) throw std::runtime_error("invalid paths");
  if (index < argc && std::string_view(argv[index]) == "--") {
    options.clang_arguments.reserve(static_cast<std::size_t>(argc - index - 1));
    for (++index; index < argc; ++index) options.clang_arguments.emplace_back(argv[index]);
    ValidateArguments(options.clang_arguments);
  } else if (index + 5 == argc && std::string_view(argv[index]) == "--arguments-file"
      && std::string_view(argv[index + 2]) == "--arguments-root" && std::string_view(argv[index + 4]) == "--") {
    options.clang_arguments = ReadArgumentsFile(fs::path(argv[index + 3]), fs::path(argv[index + 1]));
  } else {
    throw std::runtime_error("invalid arguments");
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
    if (clang_getCursorKind(current) == CXCursor_TranslationUnit) break;
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
  std::vector<fs::path> workspace_roots;
  std::string callable_usr;
  std::string type_usr;
  std::size_t emitted = 0;
  bool overflow = false;
};

bool ReserveRecord(Context& context) {
  if (++context.emitted <= 2'000'000) return true;
  context.overflow = true;
  return false;
}

bool IsCallable(CXCursorKind kind) {
  return kind == CXCursor_FunctionDecl || kind == CXCursor_FunctionTemplate || kind == CXCursor_CXXMethod
    || kind == CXCursor_Constructor || kind == CXCursor_Destructor;
}

bool IsTypeDeclaration(CXCursorKind kind) {
  return kind == CXCursor_ClassDecl || kind == CXCursor_ClassTemplate || kind == CXCursor_StructDecl
    || kind == CXCursor_UnionDecl;
}

bool IsReference(CXCursorKind kind) {
  return clang_isReference(kind) != 0 || kind == CXCursor_DeclRefExpr || kind == CXCursor_MemberRefExpr;
}

void EmitSymbolEdge(Context& context, std::string_view edge_type, const std::string& source_usr,
                    const std::string& destination_usr, const Location& location) {
  if (source_usr.empty() || destination_usr.empty() || source_usr.size() > 4096 || destination_usr.size() > 4096
      || location.file.empty() || location.file.size() > 4096 || location.line == 0 || location.column == 0
      || !IsBelowAny(context.workspace_roots, fs::path(location.file)) || !ReserveRecord(context)) return;
  std::cout << "{\"type\":\"symbol_edge\",\"edge_type\":" << Json(edge_type)
            << ",\"src_usr\":" << Json(source_usr) << ",\"dst_usr\":" << Json(destination_usr)
            << ",\"file\":" << Json(location.file) << ",\"line\":" << location.line
            << ",\"column\":" << location.column << ",\"confidence\":1}\n";
}

void EmitInclude(Context& context, CXCursor cursor, const Location& location) {
  const CXFile included = clang_getIncludedFile(cursor);
  if (included == nullptr || location.file.empty() || location.line == 0 || location.column == 0) return;
  const std::string destination = TakeString(clang_getFileName(included));
  if (destination.empty() || destination == location.file || destination.size() > 4096 || location.file.size() > 4096
      || !IsBelowAny(context.workspace_roots, fs::path(location.file))
      || !IsBelowAny(context.workspace_roots, fs::path(destination)) || !ReserveRecord(context)) return;
  std::cout << "{\"type\":\"file_edge\",\"edge_type\":\"include\",\"src_file\":" << Json(location.file)
            << ",\"dst_file\":" << Json(destination) << ",\"line\":" << location.line
            << ",\"column\":" << location.column << "}\n";
}

CXChildVisitResult Visit(CXCursor cursor, CXCursor, CXClientData data) {
  auto& context = *static_cast<Context*>(data);
  const CXCursorKind cursor_kind = clang_getCursorKind(cursor);
  const std::string previous_callable = context.callable_usr;
  const std::string previous_type = context.type_usr;
  const std::string cursor_usr = TakeString(clang_getCursorUSR(cursor));
  if (IsCallable(cursor_kind) && !cursor_usr.empty()) context.callable_usr = cursor_usr;
  if (IsTypeDeclaration(cursor_kind) && !cursor_usr.empty()) context.type_usr = cursor_usr;
  const Location evidence = SpellingLocation(clang_getRangeStart(clang_getCursorExtent(cursor)));
  const std::optional<std::string> kind = Kind(cursor_kind);
  if (kind.has_value()) {
    const CXSourceRange extent = clang_getCursorExtent(cursor);
    const Location start = SpellingLocation(clang_getRangeStart(extent));
    const Location end = SpellingLocation(clang_getRangeEnd(extent));
    if (!start.file.empty() && start.line > 0 && start.column > 0 && IsBelowAny(context.workspace_roots, fs::path(start.file))) {
      if (!ReserveRecord(context)) return CXChildVisit_Break;
      const std::string& usr = cursor_usr;
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
  if (cursor_kind == CXCursor_InclusionDirective) EmitInclude(context, cursor, evidence);
  if (cursor_kind == CXCursor_CXXBaseSpecifier && !context.type_usr.empty()) {
    const std::string destination = TakeString(clang_getCursorUSR(clang_getCursorReferenced(cursor)));
    EmitSymbolEdge(context, "inherits", context.type_usr, destination, evidence);
  }
  if (cursor_kind == CXCursor_CXXMethod && !cursor_usr.empty()) {
    CXCursor* overridden = nullptr;
    unsigned count = 0;
    clang_getOverriddenCursors(cursor, &overridden, &count);
    for (unsigned index = 0; index < count && !context.overflow; ++index) {
      EmitSymbolEdge(context, "overrides", cursor_usr, TakeString(clang_getCursorUSR(overridden[index])), evidence);
    }
    clang_disposeOverriddenCursors(overridden);
  }
  if (cursor_kind == CXCursor_CallExpr && !context.callable_usr.empty()) {
    EmitSymbolEdge(context, "calls", context.callable_usr,
      TakeString(clang_getCursorUSR(clang_getCursorReferenced(cursor))), evidence);
  }
  if (IsReference(cursor_kind) && !context.callable_usr.empty()) {
    EmitSymbolEdge(context, "references", context.callable_usr,
      TakeString(clang_getCursorUSR(clang_getCursorReferenced(cursor))), evidence);
  }
  if (!context.overflow) clang_visitChildren(cursor, Visit, &context);
  context.callable_usr = previous_callable;
  context.type_usr = previous_type;
  return context.overflow ? CXChildVisit_Break : CXChildVisit_Continue;
}

}  // namespace

int main(int argc, char** argv) {
  Options options;
  try {
    options = ParseOptions(argc, argv);
  } catch (const std::exception&) {
    std::cerr << "clang cursor indexer input rejected\n";
    return 10;
  }
  try {
    std::vector<const char*> arguments;
    arguments.reserve(options.clang_arguments.size());
    for (const std::string& argument : options.clang_arguments) arguments.push_back(argument.c_str());
    CXIndex index = clang_createIndex(1, 0);
    if (index == nullptr) return 11;
    CXTranslationUnit unit = nullptr;
    const unsigned flags = CXTranslationUnit_DetailedPreprocessingRecord;
    const CXErrorCode error = clang_parseTranslationUnit2(index, options.source.string().c_str(), arguments.data(),
      static_cast<int>(arguments.size()), nullptr, 0, flags, &unit);
    if (error != CXError_Success || unit == nullptr) {
      clang_disposeIndex(index);
      return 20 + static_cast<int>(error);
    }
    unsigned diagnostics = clang_getNumDiagnostics(unit);
    unsigned errors = 0;
    for (unsigned index_value = 0; index_value < diagnostics; ++index_value) {
      CXDiagnostic diagnostic = clang_getDiagnostic(unit, index_value);
      if (clang_getDiagnosticSeverity(diagnostic) >= CXDiagnostic_Error) ++errors;
      clang_disposeDiagnostic(diagnostic);
    }
    std::cout << "{\"type\":\"manifest\",\"schema_version\":2,\"libclang\":"
              << Json(TakeString(clang_getClangVersion())) << ",\"diagnostic_count\":" << diagnostics
              << ",\"error_count\":" << errors << "}\n";
    Context context{options.workspace_roots, "", "", 0, false};
    clang_visitChildren(clang_getTranslationUnitCursor(unit), Visit, &context);
    if (context.overflow) {
      clang_disposeTranslationUnit(unit);
      clang_disposeIndex(index);
      return 13;
    }
    clang_disposeTranslationUnit(unit);
    clang_disposeIndex(index);
    if (!std::cout.good()) return 14;
    return 0;
  } catch (const std::exception&) {
    std::cerr << "clang cursor indexer failed\n";
    return 2;
  }
}
