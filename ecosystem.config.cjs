// pm2 配置。进程名 vesper-light，和晨暮星那三个（phosphor / vesper / vesper-gateway）并列。
//
// 改了 .env 一定要带 --update-env 重启，不然新值不生效：
//   pm2 restart vesper-light --update-env
module.exports = {
  apps: [
    {
      name: 'vesper-light',
      script: 'src/light.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 4000,
      // 一分钟一次 tick，内存占用很小；涨到 200M 说明有泄漏，重启一次
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
