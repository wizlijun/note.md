# HABITAT 默认展示更多节点

当前近30天主城15节点，完整历史主城197节点（固定bc4edda）。用户要求显示更多节点，本轮将首次打开及切换Vault后的默认视角设为history，保留可切换的recent及30天定义。历史范围说明明确全库已提取概念与项目，不宣称每个都是近期关注，不混背景实体。

不修改节点筛选/提取/成长/道路/布局/模型代码，列表60条分页不限制地图传入节点，197栋继续全部渲染。远景街区标签仍按防遮挡策略，缩放或点击可看具体名称。

验证：新会话首次打开与刷新默认197主城；切近期15再切回197；背景/全部层与旧数据计数不变；197个唯一主体和全部入口、真实选择、明暗窄屏与搜索回源。生产构建及类型检查，保存default-history截图和浏览器日志。

## 验证结果

默认与刷新均显示197主城节点，实际primaryBuildings/uniqueBuildingIds/conceptAddresses/entranceAddresses全部为197，缺失入口为空；近期仍15。通过仅改变预览RPC vaultKey并触发真实window focus的loadState，验证切换Vault后重置到history197，未修改输入节点。六视图15/3/18及197/1003/1200、成长分布、真实楼体点击、明暗窄屏与河道均通过，console/pageerror/请求失败为零。

类型检查零错误/警告，生产构建index-gR3f5kaQ.js通过（既有chunk大小提示）。本轮只改App默认范围及说明，不改渲染器，无须重复上一轮GPU耐久。固定快照SHA不变，实际截图和浏览器报告在主工作区tasks/design/habitat-more-nodes-20261004/ui-final。
