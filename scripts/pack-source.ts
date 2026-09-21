// Archives the release tag rather than the working tree, so AMO's reviewers get exactly what was built.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { name, version } = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; version: string };
const tag = `v${version}`;
const output = `${name}-${version}-source.zip`;

try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`]);
} catch {
    throw new Error(`There is no tag ${tag}. Publish the release first, then fetch it with: git fetch --tags`);
}
execFileSync('git', ['archive', '--format=zip', `--output=${output}`, tag]);
console.log(`wrote ${output}`);
