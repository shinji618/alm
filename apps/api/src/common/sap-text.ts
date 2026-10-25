// SAP 자산 설명 2행(GENERALDATA-DESCRIPT2, 50자): 위치(사이트)와 룸. SAP 위치 마스터(T499S)에 의존하지 않도록 설명에 넣는다
export const desc2 = (siteCode?: string | null, roomCode?: string | null): string | undefined =>
  siteCode || roomCode ? [siteCode ? `Location: ${siteCode}` : '', roomCode ? `Room: ${roomCode}` : ''].filter(Boolean).join(' | ').slice(0, 50) : undefined;
