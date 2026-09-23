// match.js - 确定性硬筛选引擎 V1（浙江提前批 · 白皮书结构化数据）
// 设计原则：每条批次的报考资格 = 多条 OR 路径（eligibilityRules.rules），
//          路径内部各硬门槛（学历/师范类/院校层次/户籍/排名/荣誉/专项）为 AND 组合。
//          用户画像逐字段核对：任一条路径全满足 → 确定「可报」；
//          所有路径都不满足、但存在无法确认项 → 「待核实」；全明确不满足 → 「不可报」。
//          不再使用模糊打分，每条结论都附原因，零歧义。

// ========== 学历等级 ==========
const DEGREE_RANK = { '': 0, '本科': 1, '硕士': 2, '博士': 3 };

// ========== 年龄通用门槛（按学历）==========
// 白皮书提前批通用年龄线：本科≤25、硕士≤30、博士≤35（部分地区硕士28/博士35，取宽松值避免误杀真实可报者）。
// 仅当考生填写出生年份且超过对应学历上限时，将该批次判为不可报。
// 基准年按招聘「届别」走：2026届→2026、2027届→2027（用户明确「年龄按几届几届为主」）；
// 未明确届别（留学回国/择业期/不确定）回退到当前招聘周期届别，避免误算一岁。
const AGE_CAP = { 1: 25, 2: 30, 3: 35 };
const AGE_BASE_YEAR_DEFAULT = 2027;
function ageBaseYearOf(p) {
  const m = /(20\d{2})届/.exec(String((p && p.selection) || ''));
  return m ? parseInt(m[1], 10) : AGE_BASE_YEAR_DEFAULT;
}

// ========== 院校层次（用户选项 → 命中的 schoolTier token 集合）==========
// 选「不确定」→ null（该维度判为待核实）；选「普通本科」→ 空集（不满足任何特殊院校要求）
const TIER_MAP = {
  '普通本科': [],
  '省属重点师范': ['浙15所'],
  '浙师大杭师大': ['浙15所'],
  '双一流': ['双一流', '一流学科', '国内部分高校'],
  '985': ['985A类', '双一流', '一流学科', '国内部分高校'],
  '部属师范': ['部属师范6所', '双一流', '一流学科', '国内部分高校'],
  '境外世界前100': ['国境外世界前100'],
  '境外其他': ['国境外其他'],
  '国内部分高校': ['国内部分高校', '双一流', '一流学科'],
  '部属高校': ['部属高校'],
  '不确定': null
};

// ========== 教育部直属高等学校（75所，2026年教育部部门预算官方名单） ==========
// 事实核实：教育部 2026 年部门预算 PDF 列明「75 所直属高校」。白皮书各批次反复出现的
// 「教育部直属高校」即指此固定名单，并非挂在公告附件里的可枚举名单。
// 用途：让 tiersOfSchool 对这 75 所院校稳定追加 '部属高校' token，
//       补 schools.js 校名标签里漏标的情况（如北京航空航天大学仅挂了 985A类）。
const MOE_DIRECT_75 = new Set([
  '北京大学','清华大学','中国人民大学','北京师范大学','中国农业大学','北京外国语大学','北京语言大学',
  '北京科技大学','北京化工大学','北京交通大学','北京邮电大学','中国地质大学（北京）','中国矿业大学（北京）',
  '中国石油大学（北京）','北京林业大学','中国传媒大学','中央财经大学','中国政法大学','中央音乐学院',
  '中央戏剧学院','中央美术学院','北京中医药大学','对外经济贸易大学','华北电力大学','北京航空航天大学','南开大学','天津大学',
  '大连理工大学','东北大学','吉林大学','东北师范大学','东北林业大学','复旦大学','上海交通大学','同济大学',
  '华东理工大学','东华大学','华东师范大学','上海外国语大学','上海财经大学','南京大学','东南大学',
  '中国矿业大学','河海大学','江南大学','南京农业大学','中国药科大学','合肥工业大学','浙江大学','厦门大学',
  '山东大学','中国海洋大学','中国石油大学（华东）','武汉大学','华中科技大学','中国地质大学（武汉）',
  '武汉理工大学','华中师范大学','华中农业大学','中南财经政法大学','中南大学','湖南大学','中山大学',
  '华南理工大学','重庆大学','西南大学','四川大学','西南财经大学','西南交通大学','电子科技大学',
  '西安交通大学','西北农林科技大学','陕西师范大学','西安电子科技大学','长安大学','兰州大学'
]);

// ========== 浙江省重点建设高校（浙12所） ==========
// 白皮书原文「浙江省人民政府办公厅公布的第一、二批省重点建设高校」「浙江省12所重点建设本科院校（附件6）」
// 是 12 所具体院校，与「浙15所」是两份不同名单（交叉仅浙大/宁大/中国美院）。
// 用途：让 rule.schoolTier 里的「浙12所」token 能命中这 12 所学校（否则该路径形同虚设，死 token）。
const ZHE12 = new Set([
  '中国美术学院', '浙江工业大学', '浙江师范大学', '宁波大学', '杭州电子科技大学',
  '浙江理工大学', '浙江工商大学', '浙江农林大学', '温州医科大学', '浙江中医药大学',
  '浙江海洋大学', '中国计量大学'
]);

// ========== 毕业院校 → 名单归属 ==========
// 关键事实：公告里的「国内部分高校」实为《第二轮双一流建设高校名单》(147所)，
//          与「浙江省重点建设高校(浙15所)」是两份不同名单（交叉仅 浙大/宁大/中国美院）。
// 因此必须按【具体校名】判定，不能用层次下拉笼统代替。
// 返回：token 数组（[]=普通本科，均不满足）｜ null=不确定（该维度判待核实）

// token 别名：「一流学科建设高校」在地方公告里沿用第一轮称谓，但第二轮已取消
// 一流大学/一流学科的分类，统一为「双一流建设高校」(147所)。招聘实务参考的是
// 这 147 所名单，故「一流学科」按「双一流」判定（比按旧 95 所严格枚举更不容易误杀）。
// 注意：若公告进一步要求「对应建设学科」，属于专业维度，由 majorRequired/majorNote 提示。
const TIER_ALIAS = { '一流学科': '双一流' };

// 学历要求文案
function eduTxt(n) { return n === 2 ? '硕士研究生及以上' : n === 3 ? '博士研究生' : '本科及以上'; }
// 从规则原文截出「院校范围」短语，用于"名单在附件、需人工核对"的提示
function schoolScopeTxt(rule) {
  const raw = String(rule.raw || '').replace(/\s+/g, ' ');
  // 优先截出含"附件N"的片段（那才是名单出处，比"普通高校"这种泛称有用）
  const a = raw.match(/[^，。；;]{0,16}附件\s*[0-9]?[^，。；;]{0,20}/);
  if (a) return a[0].trim().slice(0, 50);
  const m = raw.match(/[^，。；;]*?(高校|院校|大学|名单)[^，。；;]*/);
  return (m ? m[0] : raw).trim().slice(0, 50);
}

// 校名归一化：支持手输简称（「浙师大」「杭师大」），表在 schools.js 的 SCHOOLS.alias
function normalizeSchoolName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return '';
  const S = (typeof window !== 'undefined' && window.SCHOOLS) || {};
  const T = S.tiers || {};
  const A = S.alias || {};
  if (Object.prototype.hasOwnProperty.call(T, n)) return n;         // 已是规范校名
  if (Object.prototype.hasOwnProperty.call(A, n)) return A[n];      // 精确简称
  for (const sp of (S.special || [])) if (sp.name === n) return n;  // 境外/不确定
  // 包含式匹配：取最长的规范校名（「浙江大学城市学院」不会误判成「浙江大学」）
  const all = [];
  Object.keys(T).forEach(x => all.push(x));
  (S.special || []).forEach(x => all.push(x.name));
  const hit = all.filter(x => n.includes(x)).sort((a, b) => b.length - a.length)[0];
  if (hit) return hit;
  for (const k in A) if (n.includes(k)) return A[k];                // 简称包含式
  return n;                                                        // 名单外 → 原样返回
}

// 用户档案的规范校名列表（本科 + 研究生）
function namesOfProfile(p) {
  let names = [];
  if (Array.isArray(p.schools) && p.schools.length) names = p.schools;
  else if (p.school) names = [p.school];
  return [...new Set(names.map(normalizeSchoolName).filter(Boolean))];
}

function tiersOfSchool(school) {
  if (!school) return [];
  const S = (typeof window !== 'undefined' && window.SCHOOLS) || null;
  if (!S) return [];
  const T = S.tiers || {};
  const key = normalizeSchoolName(school);
  let t;
  if (Object.prototype.hasOwnProperty.call(T, key)) t = T[key].slice();
  else {
    for (const sp of (S.special || [])) {          // 境外高校 / 不确定
      if (sp.name === key) { t = sp.tiers ? sp.tiers.slice() : null; break; }
    }
    if (t === undefined) t = [];                    // 名单外的院校 → 视为普通本科
  }
  if (MOE_DIRECT_75.has(key) && !t.includes('部属高校')) t = t.concat(['部属高校']); // 教育部直属75所兜底
  if (ZHE12.has(key) && !t.includes('浙12所')) t = t.concat(['浙12所']);             // 省重点建设高校(12所)兜底
  return t;
}

// 用户档案 → 命中的名单 token 集合（本科 + 研究生院校取并集）
function tiersOfProfile(p) {
  let names = [];
  if (Array.isArray(p.schools) && p.schools.length) names = p.schools;
  else if (p.school) names = [p.school];
  else if (p.schoolTier != null && TIER_MAP[p.schoolTier] !== undefined) return TIER_MAP[p.schoolTier]; // 兼容旧字段
  else return []; // 未填 → 按普通本科（用户默认语义）
  const set = new Set();
  let unknownFlag = false;
  for (const n of names) {
    const t = tiersOfSchool(n);
    if (t === null) unknownFlag = true;
    else t.forEach(x => set.add(x));
  }
  return unknownFlag ? null : [...set];
}

// ========== 中文文案 ==========
const HONOR_CN = {
  guojiang: '国家奖学金', lizhi: '国家励志奖学金', shengzheng: '省政府奖学金',
  jineng1: '省级师范生技能大赛一等奖', jineng2: '省级师范生技能大赛二等奖', jineng3: '省级师范生技能大赛三等奖',
  xiaoyoubi: '校级优秀毕业生', shengyoubi: '省级优秀毕业生',
  xiao1: '校级一等奖学金', xiao2: '校级二等奖学金', xiao3: '学年专业奖/校三等奖学金',
  youxiu: '校级优秀学生/干部', sanhao: '三好学生', yuanji: '院级荣誉', xiaojiang: '校级奖励',
  xuekejing: '学科竞赛/奥赛/联赛获奖', zhiyejineng: '职业技能大赛获奖', zonghe: '综合性荣誉',
  fushuo: '复硕(复合型硕士)', gongfei: '公费师范生', guoyou: '国优计划',
  jiaotan: '教坛新秀', mingjiaoshi: '名教师/学科骨干', jiaoxue: '教学能手/优质课', tianjiabing: '田家炳奖',
  tiyu: '运动员/教练员', yundong: '运动健将', youxiujiaoshi: '优秀教师/教练员', yiduilie: '一段线/特控线',
  dangyuan: '中共党员（含预备党员）身份', youxiudangyuan: '优秀共产党员'
};
const TIER_CN = {
  '985A类': '985高校', '一流学科': '一流学科建设高校（按双一流名单核对）', '双一流': '双一流建设高校',
  '国内部分高校': '国内部分高校（=双一流建设高校名单）', '国境外世界前100': '国（境）外世界排名前100高校',
  '国境外其他': '国（境）外高校', '浙15所': '浙江省15所重点建设高校', '部属师范6所': '教育部直属师范大学（6所）',
  '部属高校': '教育部直属高等学校（75所）',
  '浙12所': '浙江省重点建设高校（12所）',
  '省属重点师范': '浙江省属重点师范类高校（浙师大/杭师大/湖州师范/绍兴文理/温州大学/浙江外国语）'
};
// 豁免语义（原文里的"不受…限制 / 不作要求"）
const WAIVE_CN = {
  all: '不受以上条件限制', normal: '不受师范类专业限制', honors: '获奖或荣誉不作要求',
  rank: '不受成绩/排名限制', huji: '不受户籍限制', school: '不受毕业院校层次限制', edu: '不受学历限制'
};

// ========== 荣誉的「等级包含」关系 ==========
// 公告里的荣誉要求普遍写成「…及以上」（如"校级二等及以上奖学金"）。
// 若只做精确 token 匹配，手持更高级荣誉的人会被误杀。
// 下表：持有 key 时，同时视为满足 value 里的荣誉要求（方向不可逆）。
const HONOR_COVER = {
  'xiao1': ['xiao2', 'xiao3'],          // 校级一等 ⊇ 校级二等/三等
  'xiao2': ['xiao3'],
  'jineng1': ['jineng2', 'jineng3'],    // 技能竞赛一等奖 ⊇ 二等/三等
  'jineng2': ['jineng3'],
  'shengyoubi': ['xiaoyoubi', 'youxiu', 'sanhao'],   // 省级优毕 ⊇ 校级优毕及校级综合荣誉
  'xiaoyoubi': ['yuanji'],                            // 校级优毕 ⊇ 院级荣誉
  'yundong': ['tiyu']                                 // 运动健将 ⊇ 运动员
};
// 奖学金等级（数值大=等级高），用于「荣誉 AND 奖学金」门槛的等级比较（2026-09-19 新增）
const SCHOLAR_RANK = { 'xiao1': 3, 'xiao2': 2, 'xiao3': 1 };
// 省级精英班 / 荣誉学院（全省公认 8 个，报名须提供高校证明原件 + 官网公示名单）
const ELITE_CN = {
  'zjsd-chuyang':   '浙江师范大学·初阳学院',
  'hsd-jinghengyi': '杭州师范大学·经亨颐学院',
  'wzu-suchu':      '温州大学·溯初班',
  'zisu-zhuoyue':   '浙江外国语学院·卓越班',
  'usx-zunan':      '绍兴文理学院·祖楠班',
  'zjhu-huai':      '湖州师范学院·胡瑗班',
  'tzc-santai':     '台州学院·三台班',
  'lsu-xingzhi':    '丽水学院·行知班'
};
// 精英班的宿主学校：精英班是校内学院，非该校毕业生不可能属于该班
const ELITE_HOST = {
  'zjsd-chuyang':   '浙江师范大学',
  'hsd-jinghengyi': '杭州师范大学',
  'wzu-suchu':      '温州大学',
  'zisu-zhuoyue':   '浙江外国语学院',
  'usx-zunan':      '绍兴文理学院',
  'zjhu-huai':      '湖州师范学院',
  'tzc-santai':     '台州学院',
  'lsu-xingzhi':    '丽水学院'
};

// ========== 教资学段核对（record 级独立硬门槛）==========
// 岗位 certLevel：primary/junior/senior 有明确要求；any/none/None/unknown 视为不限。
// 规则：高学段教资可报低学段岗位（高中 ⊇ 初中 ⊇ 小学）；幼儿园教资独立，不能报小学。
const CERT_RANK = { '幼儿园': 0, '小学': 1, '初中': 2, '高中': 3 };
const CERT_NEED = { primary: 1, junior: 2, senior: 3 };
const CERT_NEED_CN = { primary: '小学', junior: '初中', senior: '高中' };
function certCheck(p, certLevel) {
  const need = CERT_NEED[certLevel];
  if (need == null) return { ok: true };              // 不限 / 未明确 → 不约束
  const stages = p.certStages || [];
  if (!stages.length) return { ok: true };            // 未填教资 → 不约束（避免误判为不可报）
  const myMax = Math.max(...stages.map(s => (CERT_RANK[s] == null ? -1 : CERT_RANK[s])));
  if (myMax >= need) return { ok: true };
  return { ok: false, need: CERT_NEED_CN[certLevel], have: stages.join('/') };
}

// ========== 学科自动对口（按你勾的教资学科，无需手动筛选）==========
// 报考学科由本人专业／教资学科决定，因此这里直接拿 certSubjects 与批次「涉及学科清单」比对。
// 返回 'yes'(本批有对口岗) | 'no'(本批明确无对口岗) | 'unknown'(未收录学科清单，需查原公告)
const CERT_SUBJ_PREFIX = /^(幼儿园|小学|初中|高中|中职)/;
// 学科同义词归并：批次/用户端 token 写法不一但指向同一学科，匹配时按 canonical 比较，避免误杀。
// （仅合并确为同一学科的写法；物理/化学/生物/地理等独立学科不并入，防止跨科误报）
const SUBJ_CANON = {
  '历史': '历史与社会', '社会': '历史与社会', '社会与法治': '历史与社会', '社政': '历史与社会',
  '信息': '信息技术', '计算机': '信息技术', '计算机科学与技术': '信息技术',
  '政治': '道德与法治'
};
const subjCanon = s => SUBJ_CANON[s] || s;
// 已知学科关键词（用于从「专业方向 / 本科专业」自由文本里识别学科）
const SUBJECT_WORDS = ['数学', '语文', '英语', '科学', '物理', '化学', '生物', '历史与社会', '历史', '地理', '道德与法治', '思想政治', '政治', '体育', '音乐', '美术', '信息技术', '通用技术', '心理健康', '特殊教育', '学前教育'];
// 用户「可报考学科」集合 = 教资学科 ∪ 专业方向 ∪ 本科专业（本硕不一致时按本科专业匹配学科）
function subjectsOfProfile(p) {
  const set = new Set();
  const add = (t) => { if (t) set.add(String(t)); };
  (p.certSubjects || []).forEach(s => add(String(s).replace(CERT_SUBJ_PREFIX, '')));
  (p.majors || []).forEach(raw => {
    const t = String(raw == null ? '' : raw).trim();
    if (!t) return;
    const m = t.match(/[（(]([^）)]{1,8}?)方向[）)]/);              // 小学教育（数学方向）→ 数学
    if (m) { add(m[1].replace(/[（(【].*$/, '')); return; }
    if (/^(小学教育|学前教育)$/.test(t)) return;                    // 泛小学教育不指定学科 → 不参与学科限制判定
    if (/汉语言/.test(t)) add('语文');                              // 汉语言文学 → 语文
    // 专业名→学科 扩展：专业名常不含量词，须显式列出（2026-09-19 据用户反馈扩充）
    if (/汉语国际教育|中国语言文学|古典文献|应用语言/.test(t)) add('语文');
    if (/绘画|雕塑|中国画|书法/.test(t)) add('美术');                // 绘画/雕塑/书法学 名字不含「美术」
    if (/舞蹈/.test(t)) add('音乐');                                // 舞蹈岗多归音乐类
    if (/运动训练|武术|民族传统体育/.test(t)) add('体育');           // 运动训练 名字不含「体育」
    if (/信息与计算科学/.test(t)) add('数学');
    if (/计算机|软件|网络工程|教育技术|数据科学|数字媒体/.test(t)) add('信息技术');
    if (/心理学/.test(t)) add('心理健康');                           // 心理学/应用心理学 不含「心理健康」
    if (/翻译/.test(t)) add('英语');
    if (/小学教育|学前教育/.test(t) && /数学/.test(t)) add('数学');
    SUBJECT_WORDS.forEach(x => { if (t.includes(x)) add(x); });
  });
  return [...set];
}
// 教资学段覆盖范围：高学段可报低学段
function coveredStagesOf(certStages) {
  const set = new Set();
  (certStages || []).forEach(s => {
    if (s === '高中') ['高中', '初中', '小学'].forEach(x => set.add(x));
    else if (s === '初中') ['初中', '小学'].forEach(x => set.add(x));
    else if (s === '小学') set.add('小学');
    else set.add(s);
  });
  return set;
}
function subjectFit(p, rec) {
  const mySubjects = subjectsOfProfile(p);
  if (!mySubjects.length) return 'unknown';           // 未填教资学科 / 专业方向 → 不约束
  const subs = rec.subjects || [];
  const myStages = p.certStages || [];
  // 1) 学科清单明确不含我的学科（按 canonical 归并后比对）→ 无对口岗
  if (subs.length && !mySubjects.some(s => subs.map(subjCanon).includes(subjCanon(s)))) {
    const pd = rec.postsDetail || '';
    if (mySubjects.some(s => pd.includes(s)) && !/无[^。；\n]{0,8}(岗|名额)/.test(pd)) return 'unknown';
    return 'no';
  }
  // 2) 数学岗：按 mathStage 核对学段（有岗学段全部超出我的教资覆盖 → 无对口岗）
  if (mySubjects.includes('数学') && myStages.length) {
    const ms = rec.mathStage || {};
    const yesStages = Object.keys(ms).filter(k => ms[k] === 'yes');
    if (yesStages.length) {
      const covered = coveredStagesOf(myStages);
      if (!yesStages.some(k => covered.has(k))) return 'no';
      return 'yes';               // 有我可报学段的数学岗 → 明确对口（避免误挂"岗位明细待查"）
    }
  }
  // 1.5) 本批已明确学段、但未收录学科清单：用学段范围判定（已知无小学岗却挂"待查"不准确）
  if (!subs.length && (rec.stages||[]).length && myStages.length) {
    const covered = coveredStagesOf(myStages);
    const hit = (rec.stages||[]).some(s => covered.has(s));
    return hit ? 'unknown' : 'no';   // 学段有交集→具体学科待查；完全无交集→本批无对口学段岗
  }
  if (!subs.length) return 'unknown';                 // 本批未收录学科清单 → 不判负
  return 'yes';
}

// 用户户籍 vs 规则户籍要求
// 行政区名归一：乐清市/乐清 → 乐清；吴兴区/吴兴 → 吴兴
function normArea(s) { return String(s || '').replace(/[省市区县]$/, ''); }
// required 可能是省（浙江）、市（宁波/温州）或区县（乐清/瑞安/吴兴）
function hujiMatch(required, prov, city, district) {
  if (prov === '不确定') return 'unknown';
  if (required === '浙江') return prov === '浙江' ? 'pass' : 'fail';
  if (prov !== '浙江') return 'fail';                      // 省外 → 一律不符（含"不确定"以外的具体省份）
  const req = normArea(required);
  const mine = [normArea(city), normArea(district)].filter(Boolean);
  return mine.includes(req) ? 'pass' : 'fail';             // 同省不同市/县 → 不符
}

// ========== 豁免条款（原文里的"不受…限制 / 不作要求"）==========
// 白皮书大量条款是「基础门槛 + 豁免句」的写法，例如：
//   「…且获得过校级二等及以上奖学金。教育部直属高等学校和浙江师范大学初阳学院…的毕业生获奖或荣誉不作要求」
//   若把豁免句忽略、只按 AND 硬门槛判定，符合条件的人会被误杀成"不可报"。
// rule.waivers = [{ when:{ tiers:[],names:[],elite:[],eduMin:n }, waive:['honors','normal',...] }]
//   when 内的条件是 AND（都要命中）；waive 里的门槛被豁免；'all' = 该路径全部门槛豁免。
function waiveSetOf(rule, ctx) {
  const set = new Set();
  for (const w of (rule.waivers || [])) {
    const when = w.when || {};
    const hasT = !!(when.tiers && when.tiers.length);
    const hasN = !!(when.names && when.names.length);
    const hasE = !!(when.elite && when.elite.length);
    const hasD = when.eduMin != null;
    if (!hasT && !hasN && !hasE && !hasD) continue;          // 空 when → 不成立（防止无条件豁免）
    if (hasT) {
      if (ctx.userTiers === null) continue;                   // 院校填"不确定" → 无法认定豁免
      if (!when.tiers.some(t => ctx.userTiers.includes(TIER_ALIAS[t] || t))) continue;
    }
    if (hasN && !ctx.myNames.some(n => when.names.includes(n))) continue;
    if (hasE) {
      const hit = ctx.myElite.some(x => when.elite.includes(x)) || (when.elite.includes('*') && ctx.myElite.length > 0);
      if (!hit) continue;
    }
    if (hasD && !(ctx.degreeRank >= when.eduMin)) continue;
    (w.waive || []).forEach(x => set.add(x));
  }
  return set;
}
function waiverDesc(rule) {
  const arr = [];
  (rule.waivers || []).forEach(w => (w.waive || []).forEach(x => {
    const s = WAIVE_CN[x] || x; if (!arr.includes(s)) arr.push(s);
  }));
  return arr.join('；') || '豁免条款';
}

// ========== 单条路径判定（路径内 AND）==========
// 返回 { result: 'pass'|'fail'|'unknown'|'skip', reasons: [] }
function checkPath(rule, p) {
  // 0. 引导句 / 公共说明句（如"…本科毕业生，且符合下列条件之一"、"所学专业符合报考岗位要求"）：
  //    原文里只是引出后续条件、本身不含任何硬门槛。若当作一条独立 OR 路径，任何本科生都会被判"可报" → 直接跳过。
  if (rule.guide) return { result: 'skip', reasons: ['原文为条件引导句/公共说明，不单独构成报考路径'] };

  // 专项路径（体育/竞赛教练/在职/退役）：仅当用户具备相应专项身份才适用，否则该路径对你不适用
  if (rule.specialPath) {
    const hit = (p.special || []).some(s => ['tiyu', 'jiaolian', 'zaizhi', 'tuixiu'].includes(s));
    if (!hit) return { result: 'skip', reasons: ['体育/竞赛教练等专项路径，普通考生不适用'] };
  }

  const reasons = [];
  let unknown = false;

  // ---- 身份上下文（院校判定 & 豁免判定共用，须在门槛检查前算好）----
  const myNames = namesOfProfile(p);        // 已归一化（「浙师大」→「浙江师范大学」）
  const userTiers = tiersOfProfile(p);      // null = 填了"不确定"
  const myElite = (p.elitePrograms || []).filter(id => {
    const host = ELITE_HOST[id];
    if (!host) return false;                                  // 未知精英班 id → 不认
    return myNames.length === 0 || myNames.includes(host);     // 未填学校时不强行否定
  });
  const waived = waiveSetOf(rule, { myNames, userTiers, myElite, degreeRank: DEGREE_RANK[p.degree || ''] });

  // 全豁免：原文"…的毕业生不受以上条件限制" → 该路径直接视为满足（学历仍按招聘基本要求保留）
  if (waived.has('all')) return { result: 'pass', reasons: ['符合豁免条款（' + waiverDesc(rule) + '）'] };

  // 1. 学历
  if (rule.eduMin != null && !waived.has('edu')) {
    const ur = DEGREE_RANK[p.degree || ''];
    if (ur === 0 || ur === undefined) {
      const why = ur === undefined ? ('未识别学历层次「' + (p.degree || '空') + '」') : '未填写学历层次';
      unknown = true; reasons.push(why + '，本批要求「' + eduTxt(rule.eduMin) + '」→ 补填学历后即可判定');
    }
    else if (ur < rule.eduMin) {
      return { result: 'fail', reasons: ['要求' + eduTxt(rule.eduMin)] };
    }
  }

  // 2. 师范类专业
  if (rule.normalSchool === true && !waived.has('normal')) {
    if (p.normal === '非师范类') return { result: 'fail', reasons: ['要求师范类专业'] };
    if (p.normal === '不确定') { unknown = true; reasons.push('未确定本科是否师范类专业，本批要求师范类专业 → 确认后即可判定'); }
  }

  // 精英班身份（精确到「哪所学校的哪个班」）
  //   · 各批次认可范围不同：嘉兴/绍兴/金华/衢州及杭州余杭等多只认「浙师大初阳＋杭师大经亨颐」，
  //     温州几乎全部、台州部分才认全 8 所 → 必须用集合交集判定，不能用布尔一刀切。
  //   · 精英班与院校层次在原文里多为【并列路径】（如「华中师大…和浙师大初阳学院」「浙师大、杭师大经亨颐实验班」），
  //     故精英班命中时视为同时满足院校层次门槛（否则会被 AND 误杀）。
  const ruleElite = rule.elitePrograms || (rule.eliteClass ? ['*'] : []);
  // '*' = 旧数据的布尔写法（只认「有没有精英班身份」，不区分哪所学校的哪个班）
  const eliteHit = ruleElite.length > 0 && (
    (ruleElite.includes('*') && myElite.length > 0) || myElite.some(x => ruleElite.includes(x))
  );

  // 3a. 精英班作为【唯一】院校门槛的路径（如"仅限浙江省内高校设立的2026届精英班师范类本科"）
  //     规则里没有 schoolTier / schoolNames 时，非该班成员应直接不满足 ——
  //     否则伪造精英班身份（或任何学生）都能蒙到这条路径。
  if (ruleElite.length > 0 && !eliteHit && !(rule.schoolTier || []).length && !(rule.schoolNames || []).length) {
    const need = ruleElite.map(id => ELITE_CN[id] || id).join(' 或 ');
    return { result: 'fail', reasons: ['仅限指定精英班/荣誉学院毕业生：' + need] };
  }

  // 3. 院校层次 / 具体校名白名单
  //    · rule.schoolTier  = 名单 token（双一流 / 浙15所 / 部属师范6所 …）
  //    · rule.schoolNames = 公告里【点名到具体校】的白名单（如「浙江师范大学、杭州师范大学」）
  //      两者并列 OR（原文多为"…或…"/并列顿号）。历史上把"浙师大、杭师大"整段错标成
  //      「浙15所」，会让同层次另外 13 所高校（温大、绍兴文理…）一并误放行 → 故按校名精确比对。
  //    · rule.tierUnknown = 原文点名了某份【未随白皮书给出】的名单（如"相关高校（见附件3）"、
  //      "北大清华等43所重点高校"）→ 无法枚举，只能判"待核实"，绝不能当普适放行。
  const ruleNames = rule.schoolNames || [];
  const ruleTiers = rule.schoolTier || [];
  const schoolConstrained = !!(ruleTiers.length || ruleNames.length);
  if (!waived.has('school') && !eliteHit) {
    if (schoolConstrained) {
      const tierHit = userTiers !== null && ruleTiers.some(t => userTiers.includes(TIER_ALIAS[t] || t));
      const nameHit = ruleNames.length > 0 && myNames.some(n => ruleNames.includes(n));
      const needTxt = ruleTiers.map(t => TIER_CN[t] || t).concat(ruleNames).join(' 或 ');
      if (tierHit || nameHit) { /* 满足 */ }
      else if (userTiers === null) {                               // 院校填了"不确定"
        unknown = true;
        reasons.push('毕业院校「' + (myNames.join('、') || '未填') + '」不在已收录名单内，本批限「' + needTxt + '」→ 需对照公告附件确认是否属于该范围');
      } else if (rule.tierUnknown) {                               // 名单无法枚举，确无法判定
        unknown = true;
        reasons.push('本批院校范围是「' + schoolScopeTxt(rule) + '」，该名单见公告附件、无法自动枚举 → 需人工核对');
      } else {
        return { result: 'fail', reasons: ['要求毕业院校：' + needTxt] };
      }
    } else if (rule.tierUnknown) {
      unknown = true;   // 原文限定了院校名单但名单未收录 → 待核实
      reasons.push('本批院校范围是「' + schoolScopeTxt(rule) + '」，该名单见公告附件、无法自动枚举 → 需人工核对');
    }
  }

  // 3b. 仅国内院校路径（domesticOnly）：境外院校直接不满足，避免境外硕士蹭国内硕士路径
  if (rule.domesticOnly && userTiers && userTiers.some(t => /境外/.test(String(t)))) {
    return { result: 'fail', reasons: ['本批仅面向国内普通高校毕业生'] };
  }

  // 3c. 学科限制：有些路径只面向特定学科的考生，例如
  //     「紧缺学科初中地理、政治、历史和高中地理、历史的招聘对象，除符合上述条件的人员外，普通高校本科师范类毕业生也可报考」
  //     —— 若不做学科核对，任何师范类本科生（哪怕考数学）都会被误判"可报"。
  //     铁律：用户学科未填 → 不约束（不判负）。
  if (rule.onlySubjects && rule.onlySubjects.length) {
    const mySubs = subjectsOfProfile(p);
    if (mySubs.length && !mySubs.some(s => rule.onlySubjects.includes(s))) {
      return { result: 'fail', reasons: ['本路径仅面向' + rule.onlySubjects.join('/') + '学科考生'] };
    }
  }

  // 4. 户籍 / 生源地（支持多值 OR：原文「宁波或浙江户籍」等须任一项满足即过）
  if (rule.huji && rule.huji.length && !waived.has('huji')) {
    let hujiPass = false, hujiUnknown = false, hujiFail = false;
    const needList = [];
    for (const h of rule.huji) {
      if (h === '不限') { hujiPass = true; break; }
      if (h === '详见附件') { hujiUnknown = true; needList.push('附件所列'); continue; }
      needList.push(h);
      const r = hujiMatch(h, p.hujiProv, p.hujiCity, p.hujiDistrict);
      if (r === 'pass') { hujiPass = true; break; }
      if (r === 'unknown') hujiUnknown = true; else hujiFail = true;
    }
    if (!hujiPass) {
      const needTxt = needList.join('/');
      if (hujiFail) { return { result: 'fail', reasons: ['限' + needTxt + '户籍/生源'] }; }
      if (hujiUnknown) {
        if (needList.some(x => x !== '附件所列')) {
          unknown = true; reasons.push('户籍省份填了「不确定」，本批限「' + needTxt + '」→ 补填户籍后即可判定');
        } else {
          unknown = true; reasons.push('本批户籍/生源范围写在公告附件里 → 需人工核对');
        }
      }
    }
  }

  // 5. 综合成绩排名
  if (rule.rankPctMax != null && !waived.has('rank')) {
    if (p.rank === '不确定' || p.rank === '') { unknown = true; reasons.push('未填写综合成绩排名，本批要求前' + rule.rankPctMax + '% → 补填排名后即可判定'); }
    else if (p.rank === '无') return { result: 'fail', reasons: ['要求综合成绩排名前' + rule.rankPctMax + '%'] };
    else if (parseInt(p.rank, 10) > rule.rankPctMax) {
      return { result: 'fail', reasons: ['要求综合成绩排名前' + rule.rankPctMax + '%'] };
    }
  }

  // 5b. 高考录取批次门槛（"本科录取时高考分数达特殊类型招生控制线/一段线/第一批线"）
  //     这是硬前提条件。表单语义与荣誉一致：未勾选 = 本人不满足 → 直接判不可报（2026-09-19 用户确认）。
  if (rule.requireYiduilie && !waived.has('all') && !waived.has('rank')) {
    if (!(p.special || []).includes('yiduilie')) {
      return { result: 'fail', reasons: ['本批要求本科为高考一段线/特控线录取（如满足该条件，请在左侧「专项身份」勾选「高考一段线/特控线」）'] };
    }
  }

  // 6. 荣誉 / 专项身份：未勾 = 没有（用户默认语义），不满足即不可报
  //    公费师范生/复硕/国优计划/特控线在表单里存于"专项身份"(p.special)，须与荣誉(p.honors)合并核对
  if (rule.honorsAny && rule.honorsAny.length && !waived.has('honors')) {
    const owned = (p.honors || []).concat(p.special || []);
    // 展开等级包含：手持更高级荣誉时，自动视为满足较低等级要求
    const expanded = new Set(owned);
    owned.forEach(h => (HONOR_COVER[h] || []).forEach(x => expanded.add(x)));
    const inter = [...expanded].filter(h => rule.honorsAny.includes(h));
    const need = rule.honorsAny.map(h => HONOR_CN[h] || h).join('/');
    if (inter.length === 0) {
      return { result: 'fail', reasons: ['未满足荣誉/身份要求：' + need] };
    }
  }

  // 6a. 规则内「荣誉 AND 奖学金」门槛（2026-09-19 用户确认：荣誉+奖学金两个都要）
  //     例：龙港「三好学生/优秀学生干部荣誉（且获得一次校级三等奖学金）」。
  //     仅持荣誉、无对应等级奖学金者 → 不可报（避免误放行）。
  if (rule.needScholarship && !waived.has('honors')) {
    const needRank = SCHOLAR_RANK[rule.needScholarship] || 1;
    const owned = (p.honors || []).concat(p.special || []);
    const expanded = new Set(owned);
    owned.forEach(h => (HONOR_COVER[h] || []).forEach(x => expanded.add(x)));
    const haveScholar = [...expanded].some(h => SCHOLAR_RANK[h] != null && SCHOLAR_RANK[h] >= needRank);
    if (!haveScholar) {
      return { result: 'fail', reasons: ['本批要求同时具备荣誉与奖学金（' + (HONOR_CN[rule.needScholarship] || rule.needScholarship) + '及以上），仅有荣誉未满足'] };
    }
  }

  // 6b. 精英班 / 荣誉学院身份（独立门槛，非"浙15所"）
  //     精确匹配：只有你所属的「学校+精英班」被本批原文认可时才算过。
  //     例：嘉兴/绍兴/金华多数批次只认浙师大初阳＋杭师大经亨颐；温州台州部分认全 8 所。
  if (ruleElite.length && !eliteHit) {
    const names = ruleElite.map(id => ELITE_CN[id] || id).join('、');
    return { result: 'fail', reasons: ['仅限指定精英班/荣誉学院：' + names] };
  }

  // 6c. 规则内「职务 AND 荣誉」门槛（2026-09-19 用户确认：班长/学生会主席等职务不算荣誉，
  //     但部分批次明确要求具备此类职务经历。前端未采集职务字段，无法自动判定 → 标待核实）
  if (rule.needRole && !waived.has('honors')) {
    unknown = true;
    reasons.push('本批要求具备班长/学生会主席等职务经历（且须同时具备荣誉），请确认你是否有相关职务，否则不满足');
  }

  // 7. 应届身份
  if (rule.selection) {
    if (p.selection === '不确定') { unknown = true; reasons.push('未确定应届身份，本批限应届毕业生 → 补填后即可判定'); }
    else if (rule.selection === '应届' && !(p.selection === '2026届' || p.selection === '留学回国')) {
      if (p.selection === '择业期') return { result: 'fail', reasons: ['仅面向2026届应届毕业生'] };
    }
  }

  if (unknown) return { result: 'unknown', reasons };
  return { result: 'pass', reasons };
}

// ========== 主匹配 ==========
// 「公告无门槛」必须名副其实：若规则里其实编了任何实质门槛（学历/院校/荣誉/排名/户籍/
// 特控线/学科限制/师范限制等），不得借 openEligible 直接放行，须走正常路径评估 ——
// 防止数据补录后门槛被「公告无门槛」徽章掩盖（2026-09-19 修复：江山/龙泉/缙云/遂昌等批次
// 白皮书写明"硕士及以上"，却因 openEligible 直通被判可报）。
function hasSubstantiveGates(er) {
  const rules = (er && er.rules) || [];
  return rules.some(ru => {
    if (!ru || ru.guide) return false;
    return ru.eduMin != null
      || (ru.schoolTier && ru.schoolTier.length)
      || (ru.schoolNames && ru.schoolNames.length)
      || !!ru.tierUnknown
      || (ru.honorsAny && ru.honorsAny.length)
      || ru.rankPctMax != null
      || ru.needScholarship != null
      || !!ru.needRole
      || (ru.huji && ru.huji.length && ru.huji[0] !== '不限')
      || !!ru.eliteClass || (ru.elitePrograms && ru.elitePrograms.length)
      || !!ru.requireYiduilie
      || (ru.onlySubjects && ru.onlySubjects.length)
      || ru.normalSchool === true;
  });
}
// profile: { degree, schoolTier, normal, hujiProv, hujiCity, selection, rank, honors:[], special:[] }
function matchJobs(profile, data) {
  const records = data.records;
  const out = [];
  for (const r of records) {
    let status, hitRuleId = null, reasons = [], unknownReasons = [], passDetail = null;

    if (r.conditionUnknown) {
      status = 'maybe';
      unknownReasons.push('该批次报考条件原文未明确，需查阅原公告');
    } else if (r.openEligible && !hasSubstantiveGates(r.eligibilityRules)) {
      status = 'ok';
      passDetail = '该批次公告层面未设院校层次/荣誉/排名/户籍门槛，人人可报名。「可报」=可报名，不代表符合具体岗位的全部条件：年龄上限、学历、专业对口、教资学科、工作经验/职称等写在岗位表里（本工具未收录）→ 报名前务必对照原公告岗位表逐条核对';
    } else {
      const paths = r.eligibilityRules.rules.map(ru => ({ ru, res: checkPath(ru, profile) }));
      // 引导句/公共说明句（guide）不构成路径，先从判定集合里剔除；
      // 只有「整批条件都只剩引导句」时才说明数据没提取出实质条件 → 转"待核实"，避免误杀。
      const substance = paths.filter(x => x.res.result !== 'skip');
      const pass = substance.find(x => x.res.result === 'pass');
      const unknown = substance.find(x => x.res.result === 'unknown');
      const hasGuide = paths.some(x => x.ru.guide && x.res.result === 'skip');
      if (pass) {
        status = 'ok';
        hitRuleId = pass.ru.ruleId;
        passDetail = pass.ru.raw;
        // 若该路径是靠"不受…限制/不作要求"的豁免条款通过的，明确写出来便于核对
        if (pass.res.reasons && pass.res.reasons.length && /豁免/.test(pass.res.reasons[0])) {
          passDetail = pass.ru.raw + '\n【本批豁免条款已生效】' + pass.res.reasons[0];
        }
      } else if (unknown) {
        status = 'maybe';
        // 带上「本批第 N 条」定位，便于对照原公告核对；
        // 若该条没能给出具体原因，用规则原文摘要兜底（不能只显示一句"存在需确认的报考条件"）
        const rid = unknown.ru.ruleId || '';
        unknownReasons = unknown.res.reasons.length
          ? unknown.res.reasons.map(t => '本批第' + rid + '条条件：' + t)
          : ['本批第' + rid + '条条件「' + String(unknown.ru.raw || '').replace(/\s+/g, ' ').slice(0, 50) + '…」无法自动判定 → 需对照原公告确认'];
      } else if (!substance.length && hasGuide) {
        status = 'maybe';
        unknownReasons = ['本批条件的引导条款尚未展开，须对照原公告逐条确认'];
      } else {
        status = 'no';
        const fails = substance.filter(x => x.res.result === 'fail');
        // 单条路径 → 直接说清卡在哪；多条路径（OR）→ 逐条列"公费师范生""硕士"这类
        //   单一门槛会误导（用户并非需要满足那一条），故只给"均不满足"的结论，细节留给卡片弹窗。
        if (fails.length <= 1) reasons = fails.length ? fails[0].res.reasons : ['不满足本批报考条件'];
        else reasons = ['本批共 ' + substance.length + ' 条报考路径，你的条件均不满足（点击卡片查看每条路径的详细要求）'];
      }
    }

    // 教资学段核对（独立硬门槛）：明确不足 → 降级为不可报（可报/待核实都受约束）
    if (status === 'ok' || status === 'maybe') {
      const cc = certCheck(profile, r.certLevel);
      if (!cc.ok) {
        status = 'no';
        reasons = ['教资学段不足：该批次要求' + cc.need + '及以上教师资格（你持有：' + cc.have + '）'];
        unknownReasons = [];
        passDetail = null;
      }
    }

    // 普通话等级核对（批次级基本条件；语文岗普遍要求二甲，其他学科二乙）
    if ((status === 'ok' || status === 'maybe') && r.putonghuaMin) {
      const R = { '': 0, '二乙': 1, '二甲及以上': 2 };
      if ((R[profile.putonghua || ''] || 0) < (R[r.putonghuaMin] || 0)) {
        status = 'no';
        reasons = ['要求普通话' + r.putonghuaMin + '及以上（语文岗通常要求二甲；你未填写/未考取）'];
        unknownReasons = [];
        passDetail = null;
      }
    }

    // 年龄通用门槛（全局硬门槛，仅当考生填写出生年份且超过对应学历上限时约束）
    // 基准年按招聘届别：2026届→2026、2027届→2027（用户明确「年龄按几届几届为主」）
    if ((status === 'ok' || status === 'maybe') && profile.birthYear) {
      const by = Number(profile.birthYear);
      if (by >= 1980 && by <= 2012) {
        const dr = DEGREE_RANK[profile.degree || ''] || 0;
        const cap = AGE_CAP[dr];
        if (cap) {
          const age = ageBaseYearOf(profile) - by;
          if (age > cap) {
            status = 'no';
            reasons = ['年龄超过通用门槛：' + (dr ? eduTxt(dr) : '该学历') + '一般要求' + cap + '周岁及以下（你约 ' + age + ' 周岁，按' + ageBaseYearOf(profile) + '届计）。最终以原公告为准'];
            unknownReasons = [];
            passDetail = null;
          }
        }
      }
    }

    // 学科/学段对口校验（独立硬门槛，与 certCheck/普通话/年龄 同级）：
    // 本批明确无用户学科或学段对口岗 → 不可报（落实「按专业+教资证匹配对应公告」，杜绝跨专业串科误报）
    if ((status === 'ok' || status === 'maybe')) {
      const sf = subjectFit(profile, r);
      if (sf === 'no') {
        status = 'no';
        reasons = ['本批无你的学科或学段对口岗位（具体岗位学科以原公告岗位表为准）'];
        unknownReasons = [];
        passDetail = null;
        hitRuleId = null;
      }
    }

    const _hitRule = (r.eligibilityRules.rules || []).find(x => x.ruleId === hitRuleId) || {};
    out.push({
      id: r.id, city: r.city, district: r.district, batch: r.batch,
      staffingType: r.staffingType, conditionUnknown: r.conditionUnknown,
      openEligible: r.openEligible, referencedFrom: r.referencedFrom || null,
      timeline: r.timeline, rawOther: r.rawOther,
      // 学段 / 学科 / 教资 / 岗位明细（用于岗位匹配）
      stages: r.stages || [], mathStage: r.mathStage || {}, subjects: r.subjects || [],
      certLevel: r.certLevel || null, postsDetail: r.postsDetail || '', stageSrc: r.stageSrc || '',
      subjectFit: subjectFit(profile, r),
      // 命中路径的院校要求（弹窗展示用）
      ruleTier: _hitRule.schoolTier || [], ruleNames: _hitRule.schoolNames || [], tierUnknown: !!_hitRule.tierUnknown,
      status, hitRuleId, reasons, unknownReasons, passDetail
    });
  }
  return out;
}

window.matchJobs = matchJobs;
window.subjectsOfProfile = subjectsOfProfile;
window.hujiMatch = hujiMatch;                 // 户籍/生源地判定（含区县级），供测试与页面复用
window.onlySubjectsOfRule = function (rule) { return (rule && rule.onlySubjects) || []; };
