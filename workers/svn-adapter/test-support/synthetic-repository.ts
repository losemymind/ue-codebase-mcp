import { spawn } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function run(executablePath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const subprocess = spawn(executablePath, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, LC_ALL: 'C' },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    subprocess.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    subprocess.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    subprocess.once('error', reject);
    subprocess.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else reject(new Error(`Synthetic SVN fixture command failed (${path.basename(executablePath)}, exit ${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 512)}`));
    });
  });
}

function fixedExecutable(value: string, name: 'svn' | 'svnadmin'): string {
  if (!path.isAbsolute(value) || !new RegExp(`^${name}(?:\\.exe)?$`, 'i').test(path.basename(value))) throw new TypeError(`Expected a fixed absolute ${name} executable`);
  return value;
}

export interface SyntheticRepository {
  repositoryPath: string;
  repositoryUrl: string;
  trunkUrl: string;
  authoringWorkingCopy: string;
}

export async function createSyntheticRepository(root: string, svnPath: string, svnAdminPath: string): Promise<SyntheticRepository> {
  const svn = fixedExecutable(svnPath, 'svn');
  const svnadmin = fixedExecutable(svnAdminPath, 'svnadmin');
  const repositoryPath = path.join(root, 'repository');
  const seed = path.join(root, 'seed');
  const sourceDirectory = path.join(seed, 'trunk', 'Source', 'Fixture');
  const authoringWorkingCopy = path.join(root, 'authoring-wc');
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(path.join(sourceDirectory, 'Fixture.cpp'), 'int FixtureValue() { return 1; }\n', 'utf8');
  await run(svnadmin, ['create', repositoryPath]);
  const repositoryUrl = pathToFileURL(repositoryPath).href;
  const trunkUrl = `${repositoryUrl}/trunk`;
  await run(svn, ['import', '--non-interactive', '--no-auth-cache', '--quiet', '--message', 'synthetic initial revision', seed, repositoryUrl]);
  await run(svn, ['checkout', '--non-interactive', '--no-auth-cache', '--quiet', '--revision', '1', trunkUrl, authoringWorkingCopy]);
  return { repositoryPath, repositoryUrl, trunkUrl, authoringWorkingCopy };
}

export async function commitSyntheticHeadChange(repository: SyntheticRepository, svnPath: string): Promise<void> {
  const svn = fixedExecutable(svnPath, 'svn');
  const source = path.join(repository.authoringWorkingCopy, 'Source', 'Fixture', 'Fixture.cpp');
  await appendFile(source, 'int FixtureValueTwo() { return 2; }\n', 'utf8');
  await run(svn, ['commit', '--non-interactive', '--no-auth-cache', '--quiet', '--message', 'synthetic head change', repository.authoringWorkingCopy]);
}
