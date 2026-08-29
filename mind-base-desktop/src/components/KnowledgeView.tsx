/**
 * 知识库视图：语义搜索 + 已入库文档管理（原工作区两卡，问答已并入对话）。
 */

import SearchCard from "./workspace/SearchCard";
import DocumentsCard from "./workspace/DocumentsCard";

function KnowledgeView(): React.JSX.Element {
  return (
    <div className="settings-pane">
      <SearchCard />
      <DocumentsCard />
    </div>
  );
}

export default KnowledgeView;
