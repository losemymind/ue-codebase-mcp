import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
await mkdir(dist, { recursive: true });
for (const file of ['VERSION', 'LICENSE_POLICY.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md']) {
  await cp(path.join(root, file), path.join(dist, file));
}
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const { CONFIG_VERSION, loadConfigFile } = await import('../packages/config/src/index.ts');
await import('../packages/auth/src/index.ts');
await import('../packages/contracts/src/read-only-tools.ts');
await import('../apps/mcp-server/src/cursor.ts');
await import('../apps/mcp-server/src/server.ts');
await import('../apps/mcp-server/src/streamable-http.ts');
await import('../workers/svn-adapter/src/index.ts');
await import('../workers/windows-agent/src/index.ts');
await import('../services/index-coordinator/src/workspace.ts');
await import('../services/index-coordinator/src/symbol-persistence.ts');
await import('../services/index-coordinator/src/relation-persistence.ts');
await import('../services/index-coordinator/src/chunk-persistence.ts');
await import('../services/index-coordinator/src/embedding-persistence.ts');
await import('../services/index-coordinator/src/generation-publication.ts');
await import('../services/index-coordinator/src/job-lease.ts');
await import('../services/index-coordinator/src/job-http.ts');
await import('../services/retrieval/src/hybrid-ranking.ts');
await import('../services/retrieval/src/retrieval-store.ts');
await import('../services/retrieval/src/rerank.ts');
await import('../services/retrieval/src/hybrid-retrieval.ts');
await import('../services/retrieval/src/retrieval-gold.ts');
await import('../packages/provider-sdk/src/index.ts');
await import('../workers/clang-indexer/src/module-model.ts');
await import('../workers/clang-indexer/src/code-chunking.ts');
await import('../workers/clang-indexer/src/compile-database.ts');
await import('../workers/clang-indexer/src/cursor-batch.ts');
await import('../workers/clang-indexer/src/gold-comparison.ts');
await import('../workers/clang-indexer/src/relation-gold-comparison.ts');
await import('../workers/clang-indexer/src/relation-index.ts');
const configExamples = ['project', 'repository', 'provider', 'preset'];
for (const name of configExamples) {
  await loadConfigFile(path.join(root, 'configs', 'examples', `${name}-v1.yaml`));
}
const configPackageDist = path.join(dist, 'packages', 'config');
await mkdir(path.join(configPackageDist, 'src'), { recursive: true });
await cp(path.join(root, 'packages', 'config', 'package.json'), path.join(configPackageDist, 'package.json'));
await cp(path.join(root, 'packages', 'config', 'src', 'index.ts'), path.join(configPackageDist, 'src', 'index.ts'));
await cp(path.join(root, 'configs'), path.join(dist, 'configs'), { recursive: true, force: true });
for (const source of ['apps/mcp-server', 'packages/auth', 'packages/contracts', 'packages/provider-sdk', 'services/index-coordinator', 'services/retrieval', 'workers/clang-indexer', 'workers/svn-adapter', 'workers/windows-agent']) {
  await cp(path.join(root, source), path.join(dist, source), { recursive: true, force: true });
}
await cp(path.join(root, 'deploy', 'windows-service'), path.join(dist, 'deploy', 'windows-service'), { recursive: true, force: true });
const manifest = {
  name: packageJson.name,
  version: packageJson.version,
  node: packageJson.engines.node,
  typescriptRuntime: 'node-native-type-stripping',
  configurationSchemaVersion: CONFIG_VERSION,
  sourceDateEpoch: process.env.SOURCE_DATE_EPOCH ?? '0',
};
await writeFile(path.join(dist, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`built ${manifest.name}@${manifest.version}`);
