import { Octokit } from '@octokit/rest';

export async function smokeGitHubAPI(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');

  const octokit = new Octokit({ auth: token });

  // List check runs for PR #130 (a known PR in [target-repo-realtime])
  const { data } = await octokit.rest.checks.listForRef({
    owner: '[org]',
    repo: '[target-repo-realtime]',
    ref: 'main',
    per_page: 10,
  });

  // Just confirm the API responds — check-run names may vary on main
  if (data.check_runs === undefined) throw new Error('Unexpected response shape from checks.listForRef');
}
