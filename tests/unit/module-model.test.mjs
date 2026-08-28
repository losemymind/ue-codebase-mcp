import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBuildCs, parseDescriptor, parseTargetCs } from '../../workers/clang-indexer/src/module-model.ts';

const buildCs = `
using UnrealBuildTool;
public class YihuanGame : ModuleRules
{
    public YihuanGame(ReadOnlyTargetRules Target) : base(Target)
    {
        PublicDependencyModuleNames.AddRange(new string[] { "Core", "Engine" });
        PrivateDependencyModuleNames.Add("Slate");
        if (Target.Platform == UnrealTargetPlatform.Win64)
        {
            DynamicallyLoadedModuleNames.AddRange(new[] { "OnlineSubsystem" });
            if (Target.Configuration != UnrealTargetConfiguration.Shipping)
            {
                PrivateDependencyModuleNames.Add("GameplayDebugger");
            }
        }
        PrivateDependencyModuleNames.AddRange(ComputedDependencies);
    }
}
`;

test('Build.cs parser captures public/private/dynamic dependencies, source lines and nested conditions', () => {
  const model = parseBuildCs(buildCs, 'Source/YihuanGame/YihuanGame.Build.cs');
  assert.equal(model.name, 'YihuanGame');
  assert.deepEqual(model.dependencies.map(({ name, visibility }) => [name, visibility]), [
    ['Core', 'public'], ['Engine', 'public'], ['Slate', 'private'], ['OnlineSubsystem', 'dynamic'], ['GameplayDebugger', 'private'],
  ]);
  assert.equal(model.dependencies.find(({ name }) => name === 'OnlineSubsystem').condition, '(platform == Win64)');
  assert.equal(model.dependencies.find(({ name }) => name === 'GameplayDebugger').condition, '(platform == Win64) && (configuration != Shipping)');
  assert.ok(model.dependencies.every(({ source }) => source.path.endsWith('.Build.cs') && source.line > 0 && source.column > 0));
  assert.deepEqual(model.diagnostics, [{ code: 'DYNAMIC_DEPENDENCY_EXPRESSION', line: 17 }]);
});

test('uproject/uplugin descriptors normalize modules, plugins and legacy platform keys', () => {
  const project = parseDescriptor(JSON.stringify({
    EngineAssociation: '5.6',
    Modules: [{ Name: 'YihuanGame', Type: 'Runtime', LoadingPhase: 'Default', PlatformAllowList: ['Win64'] }],
    Plugins: [{ Name: 'GameplayAbilities', Enabled: true }],
  }), 'Yihuan.uproject');
  assert.equal(project.kind, 'project');
  assert.equal(project.engine_version, '5.6');
  assert.deepEqual(project.modules[0].platform_allow_list, ['Win64']);
  assert.deepEqual(project.plugins, [{ name: 'GameplayAbilities', enabled: true }]);

  const plugin = parseDescriptor(JSON.stringify({ Modules: [{ Name: 'FixtureEditor', Type: 'Editor', WhitelistPlatforms: ['Win64'] }] }), 'Plugins/Fixture/Fixture.uplugin');
  assert.equal(plugin.kind, 'plugin');
  assert.equal(plugin.modules[0].loading_phase, 'Default');
  assert.deepEqual(plugin.modules[0].platform_allow_list, ['Win64']);
});

test('UE descriptors safely accept comments, trailing commas, BOM, and an empty source-build association', () => {
  const project = parseDescriptor(`\uFEFF{
    // Source-built projects may intentionally leave this empty.
    "EngineAssociation": "",
    "Modules": [{ "Name": "HTGame", "Type": "Runtime", }],
  }`, 'HT.uproject');
  assert.equal(project.engine_version, undefined);
  assert.equal(project.modules[0].name, 'HTGame');

  const plugin = parseDescriptor(JSON.stringify({ Modules: [
    { Name: 'SharedModule', Type: 'Runtime' },
    { Name: 'SharedModule', Type: 'UncookedOnly' },
  ] }), 'Shared.uplugin');
  assert.equal(plugin.modules.length, 2);
});

test('Target.cs parser captures target type, extra modules and platform conditions without executing source', () => {
  const target = parseTargetCs(`
public class YihuanEditorTarget : TargetRules {
  public YihuanEditorTarget(TargetInfo Target) : base(Target) {
    Type = TargetType.Editor;
    ExtraModuleNames.Add("YihuanGame");
    if (Target.Platform == UnrealTargetPlatform.Win64) {
      ExtraModuleNames.AddRange(new string[] { "YihuanWindows" });
    }
  }
}`, 'Source/YihuanEditor.Target.cs');
  assert.equal(target.name, 'YihuanEditor');
  assert.equal(target.target_type, 'Editor');
  assert.deepEqual(target.extra_modules.map(({ name }) => name), ['YihuanGame', 'YihuanWindows']);
  assert.equal(target.extra_modules[1].condition, '(platform == Win64)');
});

test('unsupported rule conditions are explicit diagnostics instead of whole-file parse failures', () => {
  const target = parseTargetCs(`
public class FixtureTarget : TargetRules {
  public FixtureTarget(TargetInfo Target) : base(Target) {
    Type = TargetType.Editor;
    if (Environment.GetEnvironmentVariable("FLAG") == "1") {
      ExtraModuleNames.Add("OptionalModule");
    }
  }
}`, 'Source/Fixture.Target.cs');
  assert.equal(target.extra_modules[0].condition, '(unsupported)');
  assert.deepEqual(target.diagnostics, [{ code: 'UNSUPPORTED_CONDITION_EXPRESSION', line: 5 }]);
});

test('rule matching ignores braces and doubled quotes inside C# verbatim strings', () => {
  const target = parseTargetCs(`
public class ExporterTarget : TargetRules {
  public ExporterTarget(TargetInfo Target) : base(Target) {
    string Command = @"echo ""{0}""";
    if (Target.Platform == UnrealTargetPlatform.Win64) {
      ExtraModuleNames.Add("Exporter");
    }
  }
}`, 'Source/Exporter.Target.cs');
  assert.equal(target.extra_modules[0].name, 'Exporter');
});

test('rules parser ignores comments and rejects malformed or oversized dynamic input', () => {
  const model = parseBuildCs(buildCs.replace('PrivateDependencyModuleNames.Add("Slate");', '// PrivateDependencyModuleNames.Add("Secret");\n        PrivateDependencyModuleNames.Add("Slate");'), 'Fixture.Build.cs');
  assert.ok(!model.dependencies.some(({ name }) => name === 'Secret'));
  assert.throws(() => parseBuildCs('public class X : ModuleRules { if (Target.Platform == UnrealTargetPlatform.Win64) {', 'X.Build.cs'));
  assert.throws(() => parseDescriptor('{bad json', 'Bad.uproject'));
});
