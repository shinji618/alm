import s from './ui.module.css';

/** 자산태그 칩. onClick이 있으면 버튼(자산 상세 열기) */
export function AssetTag({ tag, onClick }: { tag: string; onClick?: (tag: string) => void }) {
  if (onClick) {
    return (
      <button type="button" className={s.tag} onClick={() => onClick(tag)}>
        {tag}
      </button>
    );
  }
  return <span className={s.tag}>{tag}</span>;
}
