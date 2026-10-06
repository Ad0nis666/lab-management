# 实验室台账管理平台

面向桌面浏览器的实验室管理 Demo，使用原生 HTML/CSS/JavaScript、Node.js 24 和 SQLite。支持账号登录、试剂档案、单瓶库存、领用流水、仪器、样本、成员角色和库存提醒。

## 本地运行

安装 Node.js 24，在项目目录执行：

```sh
npm run init-admin
npm start
```

初始化时自行设置管理员账号和密码，没有默认登录凭据。打开 <http://127.0.0.1:3000/login.html>。数据库在首次初始化时自动生成，保存在 `.data/lab.sqlite`；该目录和数据库备份不包含在公开源码中。

默认只监听本机。可通过 `LAB_DB_PATH` 指定持久化数据库位置。账号管理和数据库查询详见 [LOGIN_DEMO.md](LOGIN_DEMO.md) 与 [SQLite 使用说明](SQLITE使用说明.md)。

## 验证

接口和数据库测试无需额外 npm 依赖：

```sh
npm test
```

完整验证还需要 Python 3、SQLite 命令行和 Playwright。安装浏览器测试依赖后运行：

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run validate
```

测试使用临时数据库，不使用本地账号或业务数据。验收范围为桌面浏览器。

## 源码发布

发布内容来自 Git 跟踪的源码，不包括 `.data/`、`.env`、数据库、`.git/` 或本机系统文件。不要直接压缩整个开发目录。公开测试凭据仅用于自动化测试。

## 许可与品牌素材

项目原创代码采用 [MIT License](LICENSE)。`assets/branding/` 中的北京大学校徽、校名字样及相关标识不包含在 MIT 授权范围内，来源见 [素材说明](assets/branding/README.md)。本项目为演示项目，不代表学校官方产品；复用时请替换为自己的品牌素材。
