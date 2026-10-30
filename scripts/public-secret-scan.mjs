// Credential values are confidential. Paths, hostnames and deployment URLs are
// configuration metadata and must not be treated as leaked credentials.
const credentialKey = /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)$/;

export function findPublicSecretLeaks(env, example, files) {
  const values = Object.entries(env)
    .filter(([key, value]) => credentialKey.test(key) && typeof value === 'string' && value.length >= 8 && !example.includes(value))
    .map(([, value]) => value.toLowerCase());
  return files
    .filter(({ content }) => values.some(value => content.toLowerCase().includes(value)))
    .map(({ path }) => path);
}
