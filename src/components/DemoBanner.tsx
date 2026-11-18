import { Icon } from './Icon';

interface DemoBannerProps {
  onDismiss: () => void;
}

export function DemoBanner({ onDismiss }: DemoBannerProps) {
  return (
    <div className="banner" role="note">
      <Icon name="warning" size={20} />
      <span>
        <strong>演示数据</strong>　这里的修改可以预览，但不会写入磁盘。
      </span>
      <button type="button" className="btn-icon banner-dismiss" onClick={onDismiss} aria-label="关闭提示">
        <Icon name="close" size={18} />
      </button>
    </div>
  );
}
