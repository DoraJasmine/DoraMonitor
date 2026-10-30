# npm 发布与预览

本文适用于维护者。普通用户直接执行 `npm install -g doramonitor`，不需要运行发布步骤。

## 1. 发布前检查

1. 确认工作区只包含准备发布的修改，版本号符合 semver。
2. 检查 `package.json` 的名称、版本、仓库、作者、许可证和 `files` 白名单。
3. 运行完整门禁：

   ```bash
   npm ci
   npm test
   npm run build
   ```

4. 检查包内容，不上传本机配置、日志、凭据或会话：

   ```bash
   npm pack --dry-run
   npm publish --dry-run
   ```

`prepack` 会自动再次执行测试和前端构建，确保 tarball 中的 `dist/` 与源码一致。

## 2. 本地 tarball 预览

```bash
npm pack
SMOKE="$(mktemp -d)"
npm install --prefix "$SMOKE" ./doramonitor-<version>.tgz
"$SMOKE/node_modules/.bin/doramonitor" --version
"$SMOKE/node_modules/.bin/doramonitor" tools
"$SMOKE/node_modules/.bin/doramonitor" web --background --no-open
```

访问 `http://127.0.0.1:3847/api/health` 应返回 `{ "ok": true }`。验证后停止刚启动的服务并删除临时目录。

Windows 使用 `npm install --prefix .tmp/smoke ./doramonitor-<version>.tgz`，入口位于 `.tmp/smoke/node_modules/.bin/doramonitor`。隔离目录安装不会改动现有全局命令。

## 3. 正式发布（需要维护者明确执行）

```bash
npm whoami
npm publish
```

`publishConfig.access` 已设为 `public`。发布是不可逆的对外操作：不要通过脚本自动执行，也不要在仅要求“预览”时运行正式发布。 npm 不允许覆盖同一版本，发布后如需修正必须提升版本号。

## 4. 发布后验证

在一个不包含源码目录的环境执行：

```bash
npm install -g doramonitor@<version>
doramonitor --version
doramonitor web --background --no-open
```

同时检查 GitHub Releases、README 截图、文档链接和仓库的公开可见性。公开仓库与 npm 发布是两个独立操作。
