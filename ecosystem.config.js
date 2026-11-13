module.exports = {
    apps: [{
        name: 'fx_record_ts_bot',
        script: './dist',
        // Options reference: https://pm2.keymetrics.io/docs/usage/application-declaration/
        // args: 'run start',
        instances: 1,
        // Fork, not cluster (pm2's default once instances is set): in cluster mode every UDP bind goes through pm2, and Fluxer voice crashes on it (ERR_INTERNAL_ASSERTION in internal/cluster/child)
        exec_mode: 'fork',
        autorestart: true,
        // The bot exits with 78 when it needs you before it can run: its data check failed (run `pnpm migrate`), or config.json was just created, migrated or is newer than this build (check it, then start the bot yourself). Restarting would only repeat that
        stop_exit_codes: [78],
        watch: false,
        kill_timeout : 60000,
        max_memory_restart: '512M',
        cron_restart: '0 4 * * *',
        env_production: {
            NODE_ENV: 'production'
        }
    }],

    deploy: {
        production: {
            user: 'node',
            ref: 'origin/master',
            repo: 'https://github.com/jimchen5209/fx_record_ts_bot.git',
            path: '/var/www/production',
            'post-deploy': 'pnpm install && pnpm build:prod && pm2 reload ecosystem.config.js --env production'
        }
    }
};
