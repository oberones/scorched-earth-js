import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { releaseMetadata } from './release-metadata.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';
const image = 'ghcr.io/example/scorched-earth-claude';
const event = {
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REPOSITORY: 'Example/Scorched-Earth-Claude',
  GITHUB_REF: 'refs/tags/v1.2.3',
  GITHUB_SHA: sha,
};

test('JavaScript app version matches package metadata', () => {
  const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  const config = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  const appVersion = config.match(/^const APP_VERSION = '([^']+)';$/m)?.[1];
  assert.equal(appVersion, packageVersion);
  assert.match(appVersion, /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/);
});

for (const tag of ['v1.2.3', '1.2.3', 'v0.0.0']) {
  test(`stable release ${tag} publishes version, commit and latest`, () => {
    const version = tag.replace(/^v/, '');
    assert.deepEqual(releaseMetadata({ ...event, GITHUB_REF: `refs/tags/${tag}` }), {
      publish: true, version, tags: [`${image}:${version}`, `${image}:sha-${sha}`, `${image}:latest`],
    });
  });
}

for (const tag of ['v1.2.3-rc.1', '1.2.3-alpha.0', 'v1.2.3-0', 'v1.2.3-01a']) {
  test(`prerelease ${tag} never updates latest`, () => {
    const result = releaseMetadata({ ...event, GITHUB_REF: `refs/tags/${tag}` });
    assert.deepEqual(result.tags, [`${image}:${tag.replace(/^v/, '')}`, `${image}:sha-${sha}`]);
  });
}

for (const override of [
  { GITHUB_REF: 'refs/heads/main' },
  { GITHUB_REF: 'refs/heads/v1.2.3' },
  { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge' },
  { GITHUB_EVENT_NAME: 'pull_request' },
  { GITHUB_EVENT_NAME: 'pull_request_target' },
  { GITHUB_EVENT_NAME: 'workflow_dispatch' },
  { GITHUB_EVENT_NAME: 'release' },
]) {
  test(`non-tag event cannot publish: ${JSON.stringify(override)}`, () => {
    assert.deepEqual(releaseMetadata({ ...event, ...override }), { publish: false, version: 'dev', tags: [] });
  });
}

for (const tag of ['v1.2', 'v1.2.3.4', 'v01.2.3', 'v1.02.3', 'v1.2.03', 'v1.2.3-01',
  'v1.2.3-rc.01', 'v1.2.3-', 'v1.2.3-alpha..1', 'v1.2.3+build.1', 'latest', 'v1.2.3\n']) {
  test(`invalid tag ${JSON.stringify(tag)} fails closed`, () => {
    assert.throws(() => releaseMetadata({ ...event, GITHUB_REF: `refs/tags/${tag}` }), /Release tags/);
  });
}

test('invalid publication coordinates fail closed', () => {
  assert.throws(() => releaseMetadata({ ...event, GITHUB_REF: `refs/tags/v1.2.3-${'a'.repeat(123)}` }), /128-character/);
  assert.throws(() => releaseMetadata({ ...event, GITHUB_SHA: '0123456' }), /40-character/);
  assert.throws(() => releaseMetadata({ ...event, GITHUB_REPOSITORY: 'example/repo\nother' }), /owner\/repository/);
});
