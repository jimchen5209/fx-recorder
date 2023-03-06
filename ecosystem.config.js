module.exports = {
    apps: [{
        name: 'fx_record_ts_bot',
        script: './dist',
        // script: 'npm',
        // Options reference: https://pm2.keymetrics.io/docs/usage/application-declaration/
        // args: 'run start',
        instances: 1,
        autorestart: true,
        watch: false,
        kill_timeout : 60000,
        max_memory_restart: '512M',
        // cron_restart: '0 17 * * *',
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
            'post-deploy': 'yarn install && yarn build:prod && pm2 reload ecosystem.config.js --env production'
        }
    }
};
