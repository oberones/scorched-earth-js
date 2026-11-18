import { appendFileSync } from 'node:fs';

const numeric = '(?:0|[1-9][0-9]*)';
const identifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const semver = new RegExp(`^v?(?<version>${numeric}\\.${numeric}\\.${numeric}(?:-(?<prerelease>${identifier}(?:\\.${identifier})*))?)$`);

export function releaseMetadata(env) {
  if (env.GITHUB_EVENT_NAME !== 'push' || !env.GITHUB_REF?.startsWith('refs/tags/')) {
    return { publish: false, version: 'dev', tags: [] };
  }

  const tag = env.GITHUB_REF.slice('refs/tags/'.length);
  const match = semver.exec(tag);
  if (!match || match[0] !== tag) {
    throw new Error('Release tags must be [v]MAJOR.MINOR.PATCH with an optional SemVer prerelease; build metadata is not supported.');
  }
  const { version, prerelease } = match.groups;
  if (version.length > 128) throw new Error('Release exceeds the 128-character Docker tag limit.');
  if (!/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '')) throw new Error('A full 40-character commit SHA is required.');
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) throw new Error('A GitHub owner/repository is required.');

  const image = `ghcr.io/${env.GITHUB_REPOSITORY.toLowerCase()}`;
  const tags = [`${image}:${version}`, `${image}:sha-${env.GITHUB_SHA}`];
  if (!prerelease) tags.push(`${image}:latest`);
  return { publish: true, version, tags };
}

if (import.meta.main) {
  const metadata = releaseMetadata(process.env);
  console.log(JSON.stringify(metadata, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, [
      `publish=${metadata.publish}`,
      `version=${metadata.version}`,
      'tags<<RELEASE_TAGS',
      ...metadata.tags,
      'RELEASE_TAGS',
      '',
    ].join('\n'));
  }
}
