import Conf from 'conf';

const config = new Conf<{ githubToken?: string }>({ projectName: 'lythium' });

export function getToken(): string | undefined {
  return config.get('githubToken');
}

export function setToken(token: string): void {
  config.set('githubToken', token);
}

export function deleteToken(): boolean {
  const had = config.has('githubToken');
  config.delete('githubToken');
  return had;
}
