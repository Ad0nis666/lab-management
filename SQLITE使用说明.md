# SQLite 数据库打开与查看说明

本项目的账号和登录会话使用 SQLite 保存，默认数据库路径为：

```text
/path/to/website/.data/lab.sqlite
```

`.data` 是隐藏文件夹，数据库不会提交到 Git。只有启动后端服务或初始化账号后，才会生成数据库文件；如果配置了 `LAB_DB_PATH`，请使用该变量指定的路径。

## 1. 首次初始化数据库和管理员

在终端执行（需要 Node.js 24）：

```sh
cd /path/to/website
npm run init-admin
```

依次填写账号、显示姓名、密码和确认密码。密码输入不会显示，要求 9–128 位；账号要求 3–80 位字母、数字或 `_ . @ -`。

创建成功后会生成数据库并保存管理员账号。已经创建过账号时，无需重复初始化，初始化命令也不会覆盖已有账号。管理员初始化后，普通成员可以点击登录页的“注册账号”自行创建账号，注册信息同样保存在 users 表中。

## 2. 使用终端打开数据库

macOS 本机已经有 `sqlite3` 命令。本项目使用 WAL 模式，读取数据库还会用到 `-wal` 和 `-shm` 辅助文件。本机 SQLite 工具在这些文件不存在时，直接只读打开可能报错。

先在一个终端启动网站，并保持运行：

```sh
npm start
```

再打开另一个终端，进入项目目录后只读打开数据库：

```sh
sqlite3 -readonly .data/lab.sqlite
```

`-readonly` 表示只读打开，适合查看数据，避免误修改。出现 `sqlite>` 提示符，就表示已经进入数据库命令行。

如果提示无法打开文件，先确认数据库已经生成、网站后端仍在运行，以及终端当前位于项目目录。不要删除 WAL 辅助文件。也可以用完整路径打开：

```sh
sqlite3 -readonly '/path/to/website/.data/lab.sqlite'
```

## 3. 查看表和账号

进入 `sqlite>` 后，可以依次执行：

```sql
.tables
.schema users
.headers on
.mode column
SELECT account, display_name, role, active FROM users;
.quit
```

| 命令 | 用途 |
| --- | --- |
| `.tables` | 查看数据库中的所有表 |
| `.schema users` | 查看用户表结构 |
| `.headers on` | 显示查询结果的字段名 |
| `.mode column` | 按列对齐显示结果 |
| `SELECT account, display_name, role, active FROM users;` | 查看账号、姓名、角色和启用状态 |
| `.quit` | 退出 SQLite 命令行 |

SQL 查询末尾需要分号，点号命令无需分号。账号角色 `admin` 表示管理员，`member` 表示普通成员；`active` 为 `1` 表示启用，为 `0` 表示禁用。

当前数据库包含 `users`（账号）、`sessions`（登录会话）、`login_limits`（登录限流）和 `schema_migrations`（数据库迁移版本）。仪器、试剂和样本尚未接入数据库。

## 4. 密码与账号管理

数据库只保存带随机盐的密码哈希，无法查看原始密码。需要新增账号、启用/禁用账号或重置密码时，在项目终端使用以下命令：

```sh
npm run user -- create
npm run user -- disable 账号
npm run user -- enable 账号
npm run user -- reset-password 账号
npm run user -- rename 旧账号 新账号
```

禁用或重置密码会同时撤销旧登录会话。不要直接修改 `password_hash` 或 `active` 字段，账号管理命令会处理相应校验和会话撤销。

## 5. 网站路径与启动方式

本机网站的路径和网址如下（默认端口为 `3000`）：

| 用途 | 路径或网址 |
| --- | --- |
| 项目文件夹 | `/path/to/website` |
| 登录页面 | [http://127.0.0.1:3000/login.html](http://127.0.0.1:3000/login.html) |
| 主界面 | [http://127.0.0.1:3000/index.html](http://127.0.0.1:3000/index.html) |

在终端进入项目文件夹，再启动网站：

```sh
cd /path/to/website
npm start
```

然后在浏览器打开上面的登录网址，使用创建的账号登录。主界面需要先登录，未登录时会自动返回登录页。请通过这些网址访问网站，直接双击本地 HTML 文件无法正常使用登录服务。

本机使用时，电脑和运行 `npm start` 的终端需要保持运行。停止网站按 `Ctrl + C`；`.quit` 只用于退出 SQLite 命令行。上述 `127.0.0.1` 网址仅供这台电脑访问，正式上线后使用服务器配置的域名或地址。

部署上线后，数据库保存在服务器的持久化目录中，浏览器通过后端接口读写数据。发布新版时需要保留数据库并定期备份；`.data/lab.sqlite` 是本机开发环境的默认位置。

账号重命名会保留用户 ID、原密码、姓名、角色和启用状态，并撤销旧会话；修改后用新账号和原密码重新登录。新账号必须符合账号格式且不能与已有账号重复。
