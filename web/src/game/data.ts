// ARASAKA_IN content: every name, line and number here is original to this project.

export type Rarity = 'trash' | 'common' | 'hq' | 'rare' | 'legendary' | 'epic';
export const RARITIES: Rarity[] = ['trash', 'common', 'hq', 'rare', 'legendary', 'epic'];
export const RARITY_LABEL: Record<Rarity, string> = {
  trash: '폐품', common: '일반', hq: '고급', rare: '희귀', legendary: '전설', epic: '에픽',
};
export const RARITY_MULT: Record<Rarity, number> = {
  trash: 0.72, common: 0.86, hq: 1, rare: 1.18, legendary: 1.42, epic: 1.75,
};
export const MOD_SLOTS: Record<Rarity, [number, number]> = {
  trash: [0, 1], common: [1, 1], hq: [1, 2], rare: [2, 2], legendary: [2, 3], epic: [3, 3],
};

export type Slot = 'primary' | 'special' | 'destructive' | 'helmet' | 'upper' | 'lower' | 'boots';
export const SLOTS: Slot[] = ['primary', 'special', 'destructive', 'helmet', 'upper', 'lower', 'boots'];
export const WEAPON_SLOTS: Slot[] = ['primary', 'special', 'destructive'];
export const SLOT_LABEL: Record<Slot, string> = {
  primary: '주무기', special: '특수무기', destructive: '파괴무기',
  helmet: '머리', upper: '상의', lower: '하의', boots: '신발',
};
export const SLOT_BASES: Record<Slot, string[]> = {
  primary: ['볼트 리볼버', '니들 SMG', '스파크 권총', '코일 카빈', '플레셰트 피스톨'],
  special: ['아크 라이플', '이온 캐스터', '펄스 블래스터', '플라즈마 랜스'],
  destructive: ['레일 캐논', '분쇄 런처', '그래비티 해머', '싱귤러 모르타르'],
  helmet: ['신경 바이저', '방탄 후드', '전술 헤드셋', '거울 고글'],
  upper: ['케블라 재킷', '나노 플레이트', '라이너 코트', '외골격 조끼'],
  lower: ['강화 카고', '충격 레깅스', '세그먼트 바지'],
  boots: ['마그 부츠', '그립 러너', '사일런트 스텝'],
};
export const PREFIX: Record<Rarity, string[]> = {
  trash: ['녹슨', '테이프 감은', '삐걱대는'],
  common: ['표준형', '공장제', '중고'],
  hq: ['튜닝된', '밀스펙', '정밀'],
  rare: ['블랙라벨', '실험형', '오버드라이브'],
  legendary: ['유령의', '제로데이', '네메시스'],
  epic: ['특이점', '오메가', '아라사카 원형'],
};

export type StatKey = 'hp' | 'shield' | 'armor' | 'crit' | 'critDmg' | 'evade' | 'escape' | 'stun' | 'regen' | 'dmgPct';
export const STAT_LABEL: Record<StatKey, string> = {
  hp: '체력', shield: '실드', armor: '방어', crit: '치명타', critDmg: '치명 피해',
  evade: '회피', escape: '도주', stun: '기절', regen: '재생', dmgPct: '피해',
};
export const PCT_STATS: StatKey[] = ['crit', 'critDmg', 'evade', 'escape', 'stun', 'dmgPct'];
export const STAT_CAP: Partial<Record<StatKey, number>> = { crit: 60, evade: 35, stun: 25, escape: 85, critDmg: 250 };

export const MODULE_NAMES: Record<StatKey, string> = {
  hp: '생체 버퍼', shield: '실드 코일', armor: '세라믹 라이너', crit: '조준 보조칩',
  critDmg: '약점 분석기', evade: '반사 신경칩', escape: '도주 경로칩', stun: '쇼크 모듈',
  regen: '나노 재생기', dmgPct: '출력 증폭기',
};

export interface Heal { name: string; heal: number; med: number; parts: number; price: number }
export const HEALS: Heal[] = [
  // each tier heals roughly 40% of the HP a player has around the level it becomes available
  { name: '진통 패치', heal: 90, med: 1, parts: 1, price: 18 },
  { name: '나노 봉합기', heal: 200, med: 6, parts: 2, price: 50 },
  { name: '트라우마 키트', heal: 380, med: 14, parts: 4, price: 120 },
  { name: '재생 주사', heal: 650, med: 24, parts: 7, price: 260 },
  { name: '풀리셋 앰플', heal: 1050, med: 36, parts: 12, price: 520 },
];

export type ModKey = 'frenzied' | 'plated' | 'warded' | 'twitchy' | 'deadeye' | 'hulking';
export const ENEMY_MODS: Record<ModKey, { label: string; hint: string }> = {
  frenzied: { label: '광폭한', hint: '공격 +25%' },
  plated: { label: '장갑 두른', hint: '받는 피해 -20%' },
  warded: { label: '방벽 친', hint: '체력의 1.5배 실드' },
  twitchy: { label: '경련하는', hint: '회피 15%, 작은 실드' },
  deadeye: { label: '저격수', hint: '치명타 +15%, 치명 피해 +50%' },
  hulking: { label: '거대한', hint: '체력 ×1.8, 공격 +20%' },
};

export interface Station {
  name: string;
  blurb: string;
  areas: { name: string; min: number; max: number }[];
  dungeons: { name: string; level: number; fragment: string }[];
  enemies: string[];
  bosses: string[];
  glyph: string;
}

export const STATIONS: Station[] = [
  {
    name: '하수 순환로', glyph: '≈',
    blurb: '도시 아래로 흐르는 폐수 터널. 버려진 드론과 굶주린 스캐빈저가 산다.',
    areas: [{ name: '배수 펌프장', min: 1, max: 3 }, { name: '쥐굴 시장', min: 3, max: 6 }, { name: '침수된 변전소', min: 6, max: 9 }],
    dungeons: [{ name: '녹슨 저수조', level: 3, fragment: 'α' }, { name: '폐 정수장', level: 6, fragment: 'β' }, { name: '심층 방류구', level: 9, fragment: 'γ' }],
    enemies: ['배관 스캐빈저', '고장 난 청소 드론', '하수 갱 꼬마', '변이 쥐떼', '전선 도둑', '독가스 중독자'],
    bosses: ['펌프장 왕 그루트', '하수 여왕 메로'],
  },
  {
    name: '네온 바자르', glyph: '◈',
    blurb: '24시간 꺼지지 않는 노점가. 해적판 크롬과 가짜 장기가 거래된다.',
    areas: [{ name: '국수 골목', min: 9, max: 12 }, { name: '짝퉁 크롬 상가', min: 12, max: 15 }, { name: '홀로 간판 옥상', min: 15, max: 18 }],
    dungeons: [{ name: '밀수 창고', level: 12, fragment: 'α' }, { name: '불법 클리닉', level: 15, fragment: 'β' }, { name: '삼합회 도박장', level: 18, fragment: 'γ' }],
    enemies: ['노점 깡패', '장기 브로커', '네온 폭주족', '사이버 사기꾼', '삼합회 집행자', '해킹된 경비봇'],
    bosses: ['도박장 주인 진', '클리닉 원장 닥터 소'],
  },
  {
    name: '데이터 항만', glyph: '▤',
    blurb: '컨테이너마다 서버가 잠든 부두. 데이터 해적과 기업 보안팀이 맞붙는다.',
    areas: [{ name: '컨테이너 미로', min: 18, max: 21 }, { name: '냉각수 부두', min: 21, max: 25 }, { name: '크레인 관제탑', min: 25, max: 28 }],
    dungeons: [{ name: '침몰한 서버선', level: 21, fragment: 'α' }, { name: '세관 보관소', level: 25, fragment: 'β' }, { name: '해적 방송국', level: 28, fragment: 'γ' }],
    enemies: ['데이터 해적', '부두 보안요원', '케이블 거미봇', '항만 노조 해결사', '불법 채굴 리그', '침투 넷러너'],
    bosses: ['해적 선장 베일', '관제 AI 하버마스터'],
  },
  {
    name: '아콜로지 하층', glyph: '▲',
    blurb: '기업 탑의 아래층. 위층에 올라가지 못한 사람들과 그들을 막는 벽.',
    areas: [{ name: '서비스 승강로', min: 28, max: 32 }, { name: '수경 재배층', min: 32, max: 36 }, { name: '경비 검문소', min: 36, max: 40 }],
    dungeons: [{ name: '폐쇄된 연구동', level: 32, fragment: 'α' }, { name: '임원 대피호', level: 36, fragment: 'β' }, { name: '코어 냉각실', level: 40, fragment: 'γ' }],
    enemies: ['기업 경비대', '전투 안드로이드', '사이코 엔지니어', '보안 드론 편대', '반란군 폭파병', '실험체 탈주자'],
    bosses: ['보안 책임자 하야시', '실험체 제로-나인'],
  },
  {
    name: '블랙월 경계', glyph: '◆',
    blurb: '넷의 끝. 벽 너머에서 무언가가 이쪽을 보고 있다.',
    areas: [{ name: '데드존 회선', min: 40, max: 45 }, { name: '폭주 AI 묘지', min: 45, max: 50 }, { name: '벽의 틈', min: 50, max: 55 }],
    dungeons: [{ name: '버려진 데이터센터', level: 45, fragment: 'α' }, { name: '유령 프로토콜', level: 50, fragment: 'β' }, { name: '블랙월 균열', level: 55, fragment: 'γ' }],
    enemies: ['폭주 AI 조각', '데몬 사냥꾼', '블랙 아이스 망령', '자기복제 웜', '넷 유령', '경계 감시자'],
    bosses: ['폭주 AI 레퀴엠', '벽 너머의 목소리'],
  },
];

export const MAX_LEVEL = 60;

// '!' lore fragments found in dungeons
export const LORE: string[] = [
  '벽에 스프레이로 적힌 글: "아라사카는 비가 오는 날에도 돈을 번다."',
  '찢어진 전단지. "신경칩 무료 이식 — 첫 달 광고 시청 의무."',
  '죽은 단말기에 남은 마지막 메시지: "백업 안 했으면 너도 이제 과거야."',
  '누군가 손톱으로 긁어 놓은 숫자들. 날짜인지 좌표인지 알 수 없다.',
  '깨진 홀로 광고가 같은 말만 반복한다. "당신의 기억, 클라우드에 안전하게."',
  '낡은 노트 한 장. "블랙월은 막으려고 만든 게 아니라, 숨기려고 만든 것이다."',
  '배관에 붙은 스티커: "이 구역의 공기는 유료입니다. 숨 쉰 만큼 청구됩니다."',
  '바닥에 떨어진 신분증. 얼굴 사진만 정성스럽게 지워져 있다.',
  '스피커에서 흘러나오는 사내 방송. "오늘도 생산성 지표 102%! 휴가는 없습니다."',
  '벽돌 틈에 끼워진 쪽지: "09시 정각, 블랙마켓 문이 열린다. 늦으면 없다."',
];

// '?' quest givers: who they are and what they say
export const GIVERS = ['외팔 정비공', '은퇴한 넷러너', '수상한 약사', '떠돌이 해결사', '배달 드론 조종사', '도망친 실험체'];
export const GIVER_LINES = [
  '"이봐, 거기. 잠깐 거래 좀 하자고."',
  '"눈빛 보니 쓸 만한 러너구만."',
  '"쉿. 여기선 목소리 낮춰."',
  '"내 물건을 잃어버렸어. 대신 구해 주면 사례하지."',
];

export interface BuffDef { id: string; label: string; stat: 'dmg' | 'def' | 'shield'; pct: number }
export const BUFFS: BuffDef[] = [
  { id: 'over1', label: '과충전 I', stat: 'dmg', pct: 5 },
  { id: 'over2', label: '과충전 II', stat: 'dmg', pct: 10 },
  { id: 'over3', label: '과충전 III', stat: 'dmg', pct: 15 },
  { id: 'plate1', label: '장갑 강화 I', stat: 'def', pct: 5 },
  { id: 'plate2', label: '장갑 강화 II', stat: 'def', pct: 10 },
  { id: 'plate3', label: '장갑 강화 III', stat: 'def', pct: 15 },
  { id: 'ward1', label: '실드 증폭 I', stat: 'shield', pct: 10 },
  { id: 'ward2', label: '실드 증폭 II', stat: 'shield', pct: 20 },
  { id: 'ward3', label: '실드 증폭 III', stat: 'shield', pct: 30 },
];

export interface JobDef { id: string; name: string; desc: string }
export const JOBS: JobDef[] = [
  { id: 'print', name: '프린터 실습', desc: '공방 견습. 인쇄 숙련도가 오른다.' },
  { id: 'med', name: '의료 연구소', desc: '실험 보조. 의료 숙련도와 의료 부품.' },
  { id: 'ammo', name: '탄약 공장 라인', desc: '야간 교대. 탄약 숙련도와 탄약 부품.' },
  { id: 'scav', name: '고철 수집', desc: '폐허를 뒤진다. 고철·부품, 가끔 상자.' },
  { id: 'guard', name: '경비 알바', desc: '창고 경비. 크레딧과 경험치.' },
];
export const JOB_DURATIONS = [15, 60, 240, 480]; // minutes

/** Who greets you at each place, and the hue of its scene (degrees). */
export const PLACE_NPC: Record<string, { tag: string; npc: string; lines: string[]; hue: number }> = {
  city: { tag: '중앙 허브', npc: '', lines: ['대륙에서 가장 시끄러운 광장. 거래, 소문, 일감이 전부 여기서 시작된다.'], hue: 190 },
  rail: { tag: '모험', npc: '역무 AI 칸나', lines: ['마그레일은 초음속입니다. 멀미 봉투는 좌석 아래에 있습니다.', '다음 노선은 열쇠가 있어야 열립니다. 규정이에요.'], hue: 200 },
  forge: { tag: '제작', npc: '미오', lines: ['상자만 가져와. 분자 단위로 다시 짜 줄게. 다리는 빼고.', '폐품 상자부터 찍어. 손이 기억해야 좋은 걸 찍지.'], hue: 45 },
  smith: { tag: '무기상', npc: '도크', lines: ['총은 거짓말을 안 해. 쏘는 놈이 하지.', '반물질은 아껴. 실드 두꺼운 놈한텐 반만 박힌다.'], hue: 15 },
  pharm: { tag: '의료', npc: '간호사 린', lines: ['출혈은 셀프 서비스예요. 계산은 카운터에서.', '던전 들어가기 전에 단축칸부터 채우세요. 진심이에요.'], hue: 150 },
  terminal: { tag: '해킹', npc: '키퍼', lines: ['조각 세 개. 그게 문을 여는 유일한 방법이다.', 'ICE는 3분마다 재정렬된다. 그 틈을 노려라.'], hue: 280 },
  gigs: { tag: '일감', npc: '브로커 맥스', lines: ['자리 비울 거면 일이라도 걸어 둬. 시간도 돈이야.', '경비 알바는 지루하지만 안전하지. 대부분은.'], hue: 210 },
  market: { tag: '암시장', npc: '그림자', lines: ['아침 9시에 물건이 들어온다. 늦으면 없다.', '출처는 묻지 마. 나도 모르니까.'], hue: 300 },
  raid: { tag: '작전', npc: '지휘관 볼크', lines: ['혼자 가겠다고? 장례식은 간단하게 해 주지.', '용병 둘이면 해볼 만하다. 하루 한 번뿐이다.'], hue: 350 },
  relay: { tag: '송신', npc: '파이', lines: ['출력을 올리면 30분은 날아다닐 거야. 그다음은 몰라.'], hue: 60 },
  records: { tag: '기록', npc: '아카이브', lines: ['모든 러너의 흔적은 여기 남는다. 지워지지 않는다.'], hue: 170 },
  street: { tag: '거리', npc: '', lines: ['근처에 적의가 느껴진다. 골라서 싸워라. 여기선 회복제를 쓸 수 없다.'], hue: 330 },
};

export const RAID_BOSSES = ['중장갑 집행기 TITAN-7', '군용 AI 오로보로스', '사이보그 군벌 카르텔', '궤도 폭격 드론 하이페리온'];
export const MERCS = ['용병 레이븐', '용병 탱크', '용병 스파크', '용병 노바', '용병 독스'];

export const CREWS = ['네온 쥐떼', '크롬 수녀회', '정전 클럽', '블루 스크린', '06시 도둑들', '게이트 크래셔'];

export const COMMS: { who: string; text: string }[] = [
  { who: 'k1ra', text: '하수 순환로 저수조 보물방은 대체로 맨 끝 방이야. 미니맵 잘 봐.' },
  { who: 'ratking', text: '방벽 친 놈은 특수무기로 실드부터 벗겨. 파괴무기는 실드에 반만 박혀.' },
  { who: 'doc_null', text: '회복제는 Q W E 칸에 박아 둬. 던전에선 그게 전부야.' },
  { who: 'mox', text: '오늘 블랙마켓 물건 괜찮더라. 09시 지나면 바로 가 봐.' },
  { who: 'ghost_42', text: '분해 많이 하면 인쇄 숙련도 금방 올라. 폐품 상자는 아끼지 말고 찍어.' },
  { who: 'v3ra', text: '레이드는 용병 둘 데려가는 게 정신 건강에 좋아.' },
  { who: 'sasha', text: '길거리 싸움은 도주가 100% 성공이니까 질 것 같으면 그냥 빼.' },
  { who: 'byte', text: '터미널 ICE 크래킹 은근 짭짤함. 3분마다 한 판씩.' },
  { who: 'k1ra', text: '`(백틱) 누르면 화면이 코드 에디터로 바뀜. 팀장 지나갈 때 써.' },
  { who: 'ratking', text: '플랫라인 당하면 10초 동안 아무것도 못 해. 회복제 아끼다 죽지 마.' },
];

export const BOSS_KEY_CODE = `import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Invoice, InvoiceStatus } from './invoice.entity';

@Injectable()
export class InvoiceReconciler {
  constructor(
    @InjectRepository(Invoice) private readonly invoices: Repository<Invoice>,
  ) {}

  /** Matches settled payments against open invoices for the quarter. */
  async reconcile(quarter: string, payments: Payment[]): Promise<ReconcileReport> {
    const open = await this.invoices.find({
      where: { quarter, status: In([InvoiceStatus.Open, InvoiceStatus.Partial]) },
    });
    const byRef = new Map(open.map((inv) => [inv.reference, inv]));
    const report: ReconcileReport = { matched: 0, partial: 0, orphaned: [] };

    for (const payment of payments) {
      const invoice = byRef.get(payment.reference);
      if (!invoice) {
        report.orphaned.push(payment.id);
        continue;
      }
      invoice.paid += payment.amount;
      invoice.status = invoice.paid >= invoice.total ? InvoiceStatus.Paid : InvoiceStatus.Partial;
      invoice.status === InvoiceStatus.Paid ? report.matched++ : report.partial++;
    }

    await this.invoices.save([...byRef.values()]);
    return report;
  }
}
`;
