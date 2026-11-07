# Rich图表透明无框修复

用户反馈6.1107.3的缩放区域与block底色不一致且多出框线；本修复只改宿主交互预览CSS，不改core、图表源码或缩放逻辑。

## 根因和处理

- 默认renderer-preview有独立混色底色，Effie编译主题同时给外层block及内层预览设置背景/边框；交互视口以更高特异性统一透明、无边框/阴影。
- 视口focus-visible的整圈outline移除，键盘焦点改为原有类型文字细下划线，按钮自身焦点提示保留。
- Pele根SVG及自动全幅背景rect、Graphviz白色画布仅在交互预览中透明化。保留节点填充、图形结构与非黑色自定义配色；Graphviz黑色默认线条与文字跟随正文前景色，避免去掉白底后深色不可读。作者显式白色Graphviz画布同样在此预览透明化，显式黑色墨迹同样跟随主题；有填充的节点/分组保留黑色默认墨迹，避免浅底白字；原始SVG属性、完整图尺寸与复制能力保留。PNG背景仍按既有resolveBackground策略求值，不宣称像素完全不变。

## 验证

隔离真实RichEditor（Pele与Graphviz）48项主题/状态/挂载检查通过：默认/Effie、浅/深色、file-backed/兼容路径，默认/hover/鼠标聚焦/Tab聚焦/缩放/复位。验收加载Effie源码中实际box规则并按compiler.rs的scope_prefix映射为运行时选择器；断言内层透明、四边0、无阴影和outline，外层主题背景/边框保留，SVG画布透明、默认墨迹随正文色、图形和Markdown内容不丢失。另验作者白色/浅蓝填充节点文字仍为黑色、红色边保留。4截图已目视复核，无页面错误。

既有11组真实Rich交互回归通过，包括滚轮、拖拽与badge边界、键盘移动/适应/复位、正文输入、源码与PNG复制、窄面板、只读与工具栏偏好。

本机证据：tasks/diagram-transparent-20261107/browser/evidence.json、interaction-regression/evidence.json及截图；不将Chromium验证称为Mac物理手势测试。正式发布另冻结tag并校验实际包内CSS。两处外部EOF改动不属于本修复。
