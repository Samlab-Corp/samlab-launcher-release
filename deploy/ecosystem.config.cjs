module.exports = {
  apps: [{
    name: 'samlab-central', cwd: '/srv/samlab-central',
    script: 'node_modules/tsx/dist/cli.mjs', args: 'server.ts',
    instances: 1, exec_mode: 'fork', autorestart: true,
    kill_timeout: 300000, listen_timeout: 300000,
    env: { NODE_ENV: 'production', PORT: '3022' },
    // Load external credentials.prod into PM2 environment before starting.
  }],
};
