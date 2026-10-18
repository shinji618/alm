// 화면 사이 간단한 알림. 카테고리를 추가·수정·삭제하면 왼쪽 메뉴의 카테고리 목록을 다시 읽는다
export const CATEGORIES_CHANGED = 'alm:categories-changed';
export function notifyCategoriesChanged() { window.dispatchEvent(new Event(CATEGORIES_CHANGED)); }
