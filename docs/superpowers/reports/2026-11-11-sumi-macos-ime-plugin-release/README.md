# Sumi 0.1.13 Apple Silicon 输入法联动插件发布

已发布并在本机官方市场启用。配套宿主note.md6.1110.8已由主任务发布和安装，本报告仅记录插件侧。

源码实现869a3a42（宿主整合为7b295f73）。冻结release source0b5c3c7ba1b6f3f0923c71041315ae73142faa3b，实际host编译436a7ed7，实际插件后台构建/公证receipt源2ddc823d。既有native.frozen_sources门禁核102个原生输入和52个插件受控文件逐字节相同；原Apple receipt未改写（native-source-equivalence.json）。

插件manifest与package均0.1.13，minhost>=6.1110.8。macOS设置增加三语输入法联动说明，正文自动候选协议由配套宿主静态原生桥实现，无伪状态或无效开关。主机未升级时不能靠插件包得到原生桥。

包2467191B，SHA256 4d66c9d753997cbe6cd7e666d229f6bbb518fa0fe6840c003a496063df1353a9。DeveloperID+AppleAccepted job a5a2fcfd-e6ec-438b-81c7-c35c3986b6f3、minisign均通过。CLI spctl原始not-an-app结果未转写成功；通过既有Accepted/CDHash+真实独立进程门禁。完整原生receipt/Applelog保留在构建dist-plugins/notemd.sumi/0.1.13/native-aarch64-apple-darwin。

插件UI102测试通过。真实signed包完整解包至临时目录并带音效，stdio2+host journal13+实际host transport1通过，原始日志和每个testdriverSHA在signed-probe；直接运行同源已编testexe避免重复Cargo，不降低required-test-name和源码检查。

沿用Wrangler3.114.17+AccountAPIToken，R2包/签名不可变上传→普通/新鲜匿名完整回读和验签→兼容宿主公开gate→KV二次重读合并→公网复核。索引312→313，历史entries不变，KV与普通/fresh公网全等。未用pending-host例外。

本机/Applications/note.md.app6.1110.8的官方插件市场已显示0.1.13启用并重载；current->0.1.13，29文件与正式signed包逐字节一致。用户并发自行点击更新，agent点击返回user-changed，故不冒称是agent点击（local-installed-plugin.json）。

真实IME物理组字的最终正式App临时Vault方案已只读准备。用户正创建输入法签名证书，主agent要求暂不抢焦点/切Vault；本agent未更改原Vault、未试写正式正文、未更换本轮输入源。此物理窗口组合验收未执行，不宣称已通过。gui-plan.md列出安全路径与工具可达性边界。此前同源候选布局、两进程桥及引擎验证由主任务另记录。
