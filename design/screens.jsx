// TruyệnAudio — premium dark redesign
// All screens for the Android prototype. Each is sized for the 412×892 Android frame.

const T = {
  // Lacquered ink palette
  ink:        'oklch(0.16 0.012 260)',         // deepest base
  surface:    'oklch(0.20 0.014 260)',         // app surface
  raised:     'oklch(0.235 0.014 260)',        // cards
  raisedHi:   'oklch(0.27 0.015 260)',         // hover/active
  hairline:   'oklch(0.32 0.013 260)',         // borders
  hairlineSoft:'oklch(0.27 0.012 260 / 0.6)',
  // Typography
  text:       'oklch(0.96 0.004 260)',
  textDim:    'oklch(0.78 0.006 260)',
  textMute:   'oklch(0.60 0.008 260)',
  textFaint:  'oklch(0.46 0.010 260)',
  // Accents (premium dark, single-chroma family)
  jade:       'oklch(0.74 0.11 165)',          // primary
  jadeDim:    'oklch(0.62 0.10 165)',
  jadeGlow:   'oklch(0.74 0.11 165 / 0.18)',
  gold:       'oklch(0.80 0.10 85)',           // XP / level
  goldDim:    'oklch(0.66 0.09 85)',
  vermillion: 'oklch(0.62 0.18 27)',           // seal moments
  // Cultivation realm tints (dark-tuned)
  slate:      'oklch(0.72 0.04 260)',
  emerald:    'oklch(0.74 0.12 162)',
  yellow:     'oklch(0.82 0.13 92)',
  orange:     'oklch(0.74 0.14 55)',
  pink:       'oklch(0.76 0.12 0)',
  violet:     'oklch(0.72 0.13 295)',
  blue:       'oklch(0.72 0.12 235)',
  red:        'oklch(0.68 0.18 25)',
};

const F = {
  display: '"Cormorant Garamond", "Times New Roman", serif',
  ui:      'Inter, "Segoe UI", system-ui, sans-serif',
  mono:    '"JetBrains Mono", ui-monospace, monospace',
};

// ─── Striped placeholder for cover art ──────────────────────────
function Cover({ w, h, hue = 165, label, seed = 1, radius = 6 }) {
  const a = `oklch(0.36 0.06 ${hue})`;
  const b = `oklch(0.28 0.05 ${hue + 30})`;
  const c = `oklch(0.22 0.04 ${hue + 60})`;
  const angle = 110 + (seed * 23) % 60;
  return (
    <div style={{
      width: w, height: h, borderRadius: radius, position: 'relative',
      overflow: 'hidden', flexShrink: 0,
      background: `linear-gradient(${angle}deg, ${a} 0%, ${b} 50%, ${c} 100%)`,
      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.04), 0 8px 22px rgba(0,0,0,0.45)',
    }}>
      <div style={{
        position:'absolute', inset:0,
        backgroundImage:
          `repeating-linear-gradient(${angle - 10}deg, rgba(255,255,255,0.04) 0 1px, transparent 1px ${4 + seed % 4}px)`,
      }}/>
      <div style={{
        position:'absolute', left: 8, right: 8, bottom: 8,
        fontFamily: F.mono, fontSize: 8, letterSpacing: 0.4,
        color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase',
      }}>{label || 'cover art'}</div>
    </div>
  );
}

// ─── Status bar (custom dark, in-frame) ─────────────────────────
function StatusBar({ time = '9:30', tone = T.text }) {
  return (
    <div style={{
      height: 32, display:'flex', alignItems:'center', justifyContent:'space-between',
      padding: '0 18px', fontFamily: F.ui, fontSize: 12, fontWeight: 500,
      color: tone, position:'relative', flexShrink: 0,
    }}>
      <span>{time}</span>
      <div style={{
        position:'absolute', left:'50%', top:8, transform:'translateX(-50%)',
        width:18, height:18, borderRadius:'50%', background:'#000',
        border:'1px solid rgba(255,255,255,0.05)',
      }}/>
      <div style={{display:'flex', gap:5, alignItems:'center'}}>
        <svg width="14" height="10" viewBox="0 0 14 10" fill={tone}><path d="M0 8h2v2H0zm4-2h2v4H4zm4-3h2v7H8zm4-3h2v10h-2z"/></svg>
        <svg width="14" height="10" viewBox="0 0 14 10" fill={tone}><path d="M7 1.5L0 8.5h14L7 1.5z" opacity="0.85"/></svg>
        <span style={{fontSize:10, fontFamily: F.mono}}>87</span>
      </div>
    </div>
  );
}

// ─── Bottom nav ─────────────────────────────────────────────────
function BottomNav({ active = 'home', onChange = ()=>{} }) {
  const items = [
    { id:'home',    label:'Trang chủ',    icon: 'M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V11z' },
    { id:'search',  label:'Tìm',          icon: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm6.32 9.9l3.39 3.4-1.41 1.4-3.4-3.39 1.42-1.41z' },
    { id:'mine',    label:'Sách của tôi', icon: 'M4 5h16v3H4zm0 5h16v3H4zm0 5h10v3H4z' },
    { id:'profile', label:'Cá nhân',      icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-4 0-8 2-8 6v2h16v-2c0-4-4-6-8-6z' },
  ];
  return (
    <div style={{
      height: 64, background: T.ink,
      borderTop: `1px solid ${T.hairline}`,
      display:'grid', gridTemplateColumns:'repeat(4,1fr)',
      flexShrink: 0,
    }}>
      {items.map(it => {
        const on = it.id === active;
        return (
          <button key={it.id} onClick={() => onChange(it.id)}
            style={{
              background:'none', border:'none', display:'flex', flexDirection:'column',
              alignItems:'center', justifyContent:'center', gap:3, cursor:'pointer',
              color: on ? T.jade : T.textFaint, padding: 0,
            }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d={it.icon}/></svg>
            <span style={{fontFamily: F.ui, fontSize: 10, fontWeight: on ? 600 : 500, letterSpacing: 0.2}}>{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Tiny seal stamp (vermillion) ───────────────────────────────
function Seal({ char = '讀', size = 32 }) {
  return (
    <div style={{
      width: size, height: size, display:'inline-flex', alignItems:'center', justifyContent:'center',
      background: T.vermillion, color:'oklch(0.95 0.02 50)',
      fontFamily: F.display, fontWeight: 600, fontSize: size * 0.55,
      borderRadius: 3, boxShadow: 'inset 0 0 0 2px oklch(0.55 0.18 27), 0 1px 0 rgba(0,0,0,0.4)',
      transform: 'rotate(-4deg)', flexShrink: 0,
    }}>{char}</div>
  );
}

// ─── Mini player (sticky above bottom nav) ──────────────────────
function MiniPlayer({ playing = true, onToggle, book = 'Tu La Vũ Thần', chapter = 'Hồi 47 · Linh tuyền nguyệt ảnh', progress = 0.42 }) {
  return (
    <div style={{
      background: T.raised, borderTop: `1px solid ${T.hairline}`,
      padding: '10px 14px', display:'flex', alignItems:'center', gap: 10,
      flexShrink: 0, position:'relative',
    }}>
      <div style={{
        position:'absolute', left:0, right:0, top: -1, height: 2, background: T.hairlineSoft,
      }}>
        <div style={{height:'100%', width: `${progress*100}%`, background: T.jade}}/>
      </div>
      <Cover w={40} h={40} hue={170} seed={2} label="" radius={4}/>
      <div style={{flex:1, minWidth:0, fontFamily: F.ui}}>
        <div style={{fontSize:12, fontWeight:600, color: T.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{book}</div>
        <div style={{fontSize:10.5, color: T.textMute, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{chapter}</div>
      </div>
      <button onClick={onToggle} style={{
        width: 36, height: 36, borderRadius:'50%', border:'none', cursor:'pointer',
        background: T.jade, color: T.ink, display:'flex', alignItems:'center', justifyContent:'center',
        boxShadow: `0 0 18px ${T.jadeGlow}`,
      }}>
        {playing
          ? <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="2" y="1" width="3.5" height="12" rx="0.5"/><rect x="8.5" y="1" width="3.5" height="12" rx="0.5"/></svg>
          : <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M3 1l10 6-10 6V1z"/></svg>}
      </button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// LIBRARY (home / Tàng Kinh Các)
// ════════════════════════════════════════════════════════════════
function LibraryScreen({ onOpenBook, onOpenPlayer }) {
  const continuing = [
    { t:'Tu La Vũ Thần',         a:'Thiện Lương Đích Mật Phong', ch: 47, total: 1842, hue: 165, seed: 1 },
    { t:'Đế Bá',                  a:'Yếm Bút Tiêu Sinh',          ch: 213, total: 4607, hue: 25,  seed: 4 },
    { t:'Phàm Nhân Tu Tiên',     a:'Vong Ngữ',                    ch: 88,  total: 2448, hue: 280, seed: 7 },
    { t:'Già Thiên',              a:'Thần Đông',                  ch: 12,  total: 1819, hue: 50,  seed: 9 },
  ];
  const trending = [
    { t:'Thánh Khư',          a:'Thần Đông',         hue: 90,  seed: 11 },
    { t:'Vũ Thần Chúa Tể',  a:'Thiên Tằm Thổ Đậu',hue: 200, seed: 13 },
    { t:'Đấu Phá Thương Khung', a:'Thiên Tằm Thổ Đậu', hue: 30, seed: 15 },
    { t:'Tiên Nghịch',         a:'Nhĩ Căn',          hue: 320, seed: 17 },
  ];
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%', background: T.surface, color: T.text, fontFamily: F.ui}}>
      <StatusBar/>
      {/* Header */}
      <div style={{padding: '6px 20px 14px', display:'flex', alignItems:'center', justifyContent:'space-between', gap: 12, flexShrink:0}}>
        <div style={{minWidth: 0, flex: 1}}>
          <div style={{fontSize: 10, color: T.textMute, letterSpacing: 1.2, textTransform:'uppercase', fontFamily: F.mono, whiteSpace:'nowrap'}}>Tủ sách của bạn</div>
          <div style={{fontFamily: F.display, fontSize: 26, lineHeight: 1.05, color: T.text, fontWeight: 500, marginTop: 2, whiteSpace:'nowrap'}}>
            Chào buổi tối, <span style={{fontStyle:'italic', color: T.jade}}>Hào</span>
          </div>
        </div>
        <div style={{
          width: 38, height: 38, borderRadius:'50%',
          background: `linear-gradient(135deg, ${T.gold}, ${T.goldDim})`,
          color: T.ink, display:'flex', alignItems:'center', justifyContent:'center',
          fontFamily: F.display, fontSize: 16, fontWeight: 600,
          boxShadow: `0 0 0 1px ${T.hairline}, 0 4px 12px rgba(0,0,0,0.4)`,
        }}>H</div>
      </div>

      {/* Scrollable content */}
      <div style={{flex:1, overflow:'auto', paddingBottom: 8}}>
        {/* Continue listening — featured */}
        <div style={{padding: '0 20px'}}>
          <SectionLabel title="Nghe tiếp" sub="Truyện đang dở" />
          <div onClick={onOpenPlayer} style={{
            marginTop: 10, padding: 14, borderRadius: 10,
            background: `linear-gradient(135deg, oklch(0.26 0.04 165) 0%, ${T.raised} 70%)`,
            border: `1px solid ${T.hairline}`,
            display:'flex', gap: 14, alignItems:'center', cursor:'pointer',
            position:'relative', overflow:'hidden',
          }}>
            <div style={{position:'absolute', right:-20, top:-20, opacity: 0.08, fontFamily: F.display, fontSize: 140, color: T.jade, lineHeight: 1}}>道</div>
            <Cover w={66} h={88} hue={165} seed={1} label="TLVT"/>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontFamily: F.display, fontSize: 19, fontWeight: 500, color: T.text, lineHeight: 1.15}}>{continuing[0].t}</div>
              <div style={{fontSize: 11, color: T.textMute, marginTop: 2}}>Hồi {continuing[0].ch} · {Math.round(continuing[0].ch/continuing[0].total*100)}% · 27 phút còn lại</div>
              <div style={{marginTop: 10, height: 3, background: T.hairlineSoft, borderRadius: 2, overflow:'hidden'}}>
                <div style={{height:'100%', width: `${continuing[0].ch/continuing[0].total*100}%`, background: T.jade}}/>
              </div>
            </div>
            <div style={{
              width: 42, height: 42, borderRadius:'50%', background: T.jade, color: T.ink,
              display:'flex', alignItems:'center', justifyContent:'center',
              boxShadow:`0 0 24px ${T.jadeGlow}`,
            }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M3 1l10 6-10 6V1z"/></svg>
            </div>
          </div>
        </div>

        {/* Continue row */}
        <div style={{marginTop: 22}}>
          <div style={{padding: '0 20px'}}><SectionLabel title="Đang đọc" sub="Mới mở gần đây"/></div>
          <div style={{display:'flex', gap: 12, padding: '12px 20px', overflowX:'auto'}}>
            {continuing.slice(1).map((b,i) => (
              <div key={i} onClick={onOpenBook} style={{width: 110, flexShrink: 0, cursor:'pointer'}}>
                <Cover w={110} h={150} hue={b.hue} seed={b.seed} label={b.t.split(' ')[0]}/>
                <div style={{marginTop: 8, fontSize: 12, fontWeight: 600, color: T.text, lineHeight: 1.2,
                              overflow:'hidden', display:'-webkit-box', WebkitLineClamp:1, WebkitBoxOrient:'vertical'}}>{b.t}</div>
                <div style={{fontSize: 10, color: T.textMute, marginTop: 2, fontFamily: F.mono}}>
                  HỒI {b.ch}/{b.total}
                </div>
                <div style={{marginTop: 5, height: 2, background: T.hairlineSoft, borderRadius: 1}}>
                  <div style={{height:'100%', width: `${b.ch/b.total*100}%`, background: T.jadeDim, borderRadius: 1}}/>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Genre chips */}
        <div style={{padding: '12px 20px 0'}}>
          <SectionLabel title="Thể loại" sub="Chọn theo sở thích"/>
          <div style={{display:'flex', flexWrap:'wrap', gap: 8, marginTop: 10}}>
            {[
              ['Tu Tiên', T.jade],
              ['Huyền Huyễn', T.violet],
              ['Đô Thị', T.blue],
              ['Lịch Sử', T.gold],
              ['Khoa Huyễn', T.emerald],
              ['Kiếm Hiệp', T.vermillion],
            ].map(([g, c]) => (
              <div key={g} style={{
                padding: '7px 13px', borderRadius: 100,
                fontSize: 11.5, fontWeight: 500, color: T.text,
                background: T.raised, border: `1px solid ${T.hairline}`,
                display:'flex', alignItems:'center', gap: 6,
              }}>
                <span style={{width: 6, height: 6, borderRadius:'50%', background: c}}/>
                {g}
              </div>
            ))}
          </div>
        </div>

        {/* Trending grid */}
        <div style={{padding: '20px 20px 12px'}}>
          <SectionLabel title="Đang được yêu thích" sub="Truyện hot tuần này"/>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap: 14, marginTop: 12}}>
            {trending.map((b,i) => (
              <div key={i} onClick={onOpenBook} style={{cursor:'pointer'}}>
                <Cover w="100%" h={170} hue={b.hue} seed={b.seed} label={b.t}/>
                <div style={{marginTop: 8, fontSize: 12.5, fontWeight: 600, color: T.text, lineHeight: 1.2}}>{b.t}</div>
                <div style={{fontSize: 10.5, color: T.textMute, marginTop: 2}}>{b.a}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <MiniPlayer onToggle={onOpenPlayer}/>
      <BottomNav active="home"/>
    </div>
  );
}

function SectionLabel({ title, sub }) {
  return (
    <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap: 10}}>
      <div style={{minWidth: 0, flex: 1, display:'flex', alignItems:'baseline', gap: 10, flexWrap:'wrap'}}>
        <div style={{fontFamily: F.display, fontSize: 18, fontWeight: 500, color: T.text, lineHeight: 1.1, whiteSpace:'nowrap'}}>{title}</div>
        <div style={{fontFamily: F.mono, fontSize: 9, color: T.textFaint, letterSpacing: 1, textTransform:'uppercase', whiteSpace:'nowrap'}}>{sub}</div>
      </div>
      <button style={{background:'none', border:'none', color: T.jade, fontFamily: F.ui, fontSize: 11, fontWeight: 600, cursor:'pointer', flexShrink: 0, padding: 0}}>Xem tất cả →</button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// BOOK DETAIL
// ════════════════════════════════════════════════════════════════
function BookDetailScreen({ onBack, onListen }) {
  const chapters = [
    { i: 45, title: 'Linh tuyền hiện thế', dur: '24:18', state: 'done' },
    { i: 46, title: 'Cố nhân trùng phùng',  dur: '19:42', state: 'done' },
    { i: 47, title: 'Linh tuyền nguyệt ảnh', dur: '27:03', state: 'playing' },
    { i: 48, title: 'Phong khởi vạn lý',     dur: '22:56', state: 'cached' },
    { i: 49, title: 'Tử khí đông lai',        dur: '18:31', state: 'next' },
    { i: 50, title: 'Cửu thiên huyền nữ',    dur: '25:09', state: 'next' },
    { i: 51, title: 'Đại đạo vô tình',         dur: '23:47', state: 'next' },
  ];
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%', background: T.surface, color: T.text, fontFamily: F.ui, position:'relative'}}>
      <StatusBar/>
      <div style={{flex:1, overflow:'auto'}}>
        {/* Hero */}
        <div style={{position:'relative', padding: '4px 20px 20px'}}>
          <div style={{
            position:'absolute', inset: 0, top: -32,
            background: `radial-gradient(120% 80% at 70% 0%, oklch(0.30 0.06 165 / 0.55) 0%, transparent 60%)`,
            pointerEvents:'none',
          }}/>
          <div style={{position:'relative', display:'flex', alignItems:'center', justifyContent:'space-between'}}>
            <button onClick={onBack} style={{background:'none', border:'none', color: T.text, padding: 8, marginLeft: -8, cursor:'pointer'}}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 6l-6 6 6 6"/></svg>
            </button>
            <div style={{display:'flex', gap: 4}}>
              <IconBtn icon="M5 5h2v14H5zm5 0h2v14h-2zm5 0h2v14h-2z" rotate/>
              <IconBtn icon="M12 4v12m0 0l-4-4m4 4l4-4M5 18h14" stroke/>
            </div>
          </div>

          <div style={{display:'flex', gap: 16, marginTop: 14, position:'relative'}}>
            <Cover w={120} h={160} hue={165} seed={1} label="TU LA VŨ THẦN"/>
            <div style={{flex:1, minWidth:0, paddingTop: 4}}>
              <div style={{fontFamily: F.mono, fontSize: 9.5, letterSpacing: 1.2, color: T.jade, textTransform:'uppercase'}}>Tu Tiên · 修仙</div>
              <div style={{fontFamily: F.display, fontSize: 26, fontWeight: 500, lineHeight: 1.05, marginTop: 6, color: T.text}}>Tu La Vũ Thần</div>
              <div style={{fontSize: 12, color: T.textMute, marginTop: 6}}>Thiện Lương Đích Mật Phong</div>
              <div style={{display:'flex', gap: 12, marginTop: 12, fontFamily: F.mono, fontSize: 10, color: T.textDim}}>
                <span><span style={{color: T.gold}}>★ 4.8</span></span>
                <span>1,842 Hồi</span>
                <span>HD ✓</span>
              </div>
            </div>
          </div>
        </div>

        {/* Action row */}
        <div style={{padding: '0 20px', display:'flex', gap: 10}}>
          <button onClick={onListen} style={{
            flex: 2, height: 48, borderRadius: 8, border:'none', cursor:'pointer',
            background: T.jade, color: T.ink, fontFamily: F.ui, fontWeight: 700, fontSize: 14,
            display:'flex', alignItems:'center', justifyContent:'center', gap: 8,
            boxShadow: `0 0 28px ${T.jadeGlow}`,
          }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M3 1l10 6-10 6V1z"/></svg>
            Tiếp tục Hồi 47
          </button>
          <button style={{
            flex: 1, height: 48, borderRadius: 8, cursor:'pointer',
            background: 'transparent', color: T.text,
            border: `1px solid ${T.hairline}`, fontFamily: F.ui, fontWeight: 600, fontSize: 13,
            display:'flex', alignItems:'center', justifyContent:'center', gap: 6,
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 4v12m0 0l-4-4m4 4l4-4M5 18h14"/></svg>
            Tải về
          </button>
        </div>

        {/* Description */}
        <div style={{padding: '20px 20px 0'}}>
          <div style={{
            fontFamily: F.display, fontSize: 15, lineHeight: 1.55, color: T.textDim, fontStyle:'italic',
            borderLeft: `2px solid ${T.jade}`, paddingLeft: 12,
          }}>
            "Trên đầu ba thước có thần linh, dưới gót vạn dặm là nhân gian. Một thiếu niên áo trắng, từ Đông Châu xuất phát, bước trên con đường vũ đạo phong vân..."
          </div>
        </div>

        {/* Stat strip */}
        <div style={{margin: '18px 20px 0', padding: '14px 0', display:'grid', gridTemplateColumns:'repeat(3,1fr)',
                      borderTop: `1px solid ${T.hairline}`, borderBottom: `1px solid ${T.hairline}`}}>
          {[['1,842','Tổng hồi'],['324','Đã nghe'],['68%','Hoàn thành']].map(([n,l],i) => (
            <div key={i} style={{textAlign:'center', borderRight: i<2 ? `1px solid ${T.hairline}` : 'none'}}>
              <div style={{fontFamily: F.display, fontSize: 22, fontWeight: 500, color: T.gold}}>{n}</div>
              <div style={{fontFamily: F.mono, fontSize: 9, color: T.textMute, textTransform:'uppercase', letterSpacing: 1, marginTop: 2}}>{l}</div>
            </div>
          ))}
        </div>

        {/* Chapter list */}
        <div style={{padding: '20px 20px 20px'}}>
          <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 10}}>
            <div style={{fontFamily: F.display, fontSize: 18, fontWeight: 500}}>Mục lục</div>
            <button style={{background:T.raised, border: `1px solid ${T.hairline}`, color: T.textDim, fontSize: 11, padding: '5px 10px', borderRadius: 6, cursor:'pointer', fontFamily: F.ui, display:'flex', gap: 4, alignItems:'center'}}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h18M6 12h12m-9 5h6"/></svg>
              Sắp xếp
            </button>
          </div>
          {chapters.map((c) => {
            const playing = c.state === 'playing';
            const done    = c.state === 'done';
            const cached  = c.state === 'cached';
            return (
              <div key={c.i} style={{
                display:'flex', alignItems:'center', gap: 12,
                padding: '12px 0', borderBottom: `1px solid ${T.hairlineSoft}`,
                opacity: done ? 0.55 : 1,
              }}>
                <div style={{
                  width: 32, textAlign:'center', fontFamily: F.mono, fontSize: 11,
                  color: playing ? T.jade : T.textFaint,
                }}>
                  {playing
                    ? <div style={{display:'inline-flex', gap: 2, alignItems:'flex-end', height: 12}}>
                        <span style={{width:2, background:T.jade, height: '60%'}}/>
                        <span style={{width:2, background:T.jade, height:'100%'}}/>
                        <span style={{width:2, background:T.jade, height: '40%'}}/>
                      </div>
                    : String(c.i).padStart(3,'0')}
                </div>
                <div style={{flex:1, minWidth:0}}>
                  <div style={{fontSize: 13, fontWeight: playing ? 600 : 500, color: playing ? T.jade : T.text}}>
                    Hồi {c.i} — {c.title}
                  </div>
                  <div style={{fontFamily: F.mono, fontSize: 10, color: T.textFaint, marginTop: 2, display:'flex', gap:8}}>
                    <span>{c.dur}</span>
                    {cached && <span style={{color: T.emerald}}>● ngoại tuyến</span>}
                    {done && <span>đã hoàn thành</span>}
                  </div>
                </div>
                {!done && (
                  <div style={{
                    width: 28, height: 28, borderRadius: '50%',
                    border: `1px solid ${playing ? T.jade : T.hairline}`,
                    display:'flex', alignItems:'center', justifyContent:'center',
                    color: playing ? T.jade : T.textMute,
                  }}>
                    <svg width="9" height="9" viewBox="0 0 14 14" fill="currentColor"><path d="M3 1l10 6-10 6V1z"/></svg>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <BottomNav active="home"/>
    </div>
  );
}

function IconBtn({ icon, stroke, rotate }) {
  return (
    <button style={{
      width: 36, height: 36, borderRadius: 8, background: 'transparent',
      border: 'none', color: T.text, cursor:'pointer',
      display:'flex', alignItems:'center', justifyContent:'center',
    }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill={stroke?'none':'currentColor'}
           stroke="currentColor" strokeWidth={stroke?2:0} style={rotate?{transform:'rotate(90deg)'}:{}}>
        <path d={icon}/>
      </svg>
    </button>
  );
}

// ════════════════════════════════════════════════════════════════
// PLAYER (the hero screen)
// ════════════════════════════════════════════════════════════════
function PlayerScreen({ onClose, playing, onTogglePlay }) {
  const [progress, setProgress] = React.useState(0.42);
  const [chunkIdx, setChunkIdx] = React.useState(8);
  // Android build: native TTS only (no backend voice)
  const voice = 'native';
  const [speed, setSpeed] = React.useState('1.0×');
  const [sleep, setSleep] = React.useState(false);
  React.useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setProgress(p => {
        const np = p + 0.003;
        return np >= 1 ? 0 : np;
      });
      setChunkIdx(c => (c + 1) % 20);
    }, 800);
    return () => clearInterval(id);
  }, [playing]);

  const totalSec = 1623, cur = Math.round(totalSec * progress);
  const fmt = (s) => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;

  return (
    <div style={{
      display:'flex', flexDirection:'column', height:'100%',
      background: `radial-gradient(140% 60% at 50% -10%, oklch(0.30 0.07 165 / 0.45) 0%, ${T.ink} 55%)`,
      color: T.text, fontFamily: F.ui, position:'relative',
    }}>
      <StatusBar/>
      {/* Header */}
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding: '4px 18px 6px', flexShrink:0}}>
        <button onClick={onClose} style={{background:'none', border:'none', color: T.text, padding: 8, marginLeft:-8, cursor:'pointer'}}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <div style={{textAlign:'center'}}>
          <div style={{fontFamily: F.mono, fontSize: 9, color: T.textMute, letterSpacing: 1.5, textTransform:'uppercase'}}>Đang nghe</div>
          <div style={{fontSize: 12, color: T.textDim, marginTop: 2}}>Hồi 47 / 1,842</div>
        </div>
        <button style={{background:'none', border:'none', color: T.text, padding: 8, marginRight:-8, cursor:'pointer'}}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
      </div>

      {/* Cover with cultivation pillar */}
      <div style={{padding: '6px 28px 12px', display:'flex', justifyContent:'center', alignItems:'center', position:'relative', flex: 1, minHeight: 0}}>
        <div style={{position:'relative', width: '100%', maxWidth: 220, aspectRatio: '4 / 5', display:'flex', justifyContent:'center'}}>
          <Cover w="100%" h="100%" hue={165} seed={1} label="TU LA VŨ THẦN" radius={8}/>
          <div style={{position:'absolute', top: -10, right: -10}}><Seal char="讀" size={42}/></div>
          {/* breathing glow */}
          <div style={{
            position:'absolute', inset: -10, border: `1px solid ${T.jade}`, borderRadius: 12,
            opacity: 0.25, pointerEvents:'none',
            animation: playing ? 'breathe 3.2s ease-in-out infinite' : 'none',
          }}/>
        </div>
      </div>

      {/* Title + chunks rail */}
      <div style={{padding: '0 28px 14px', flexShrink: 0}}>
        <div style={{fontFamily: F.display, fontSize: 22, fontWeight: 500, lineHeight: 1.15, color: T.text}}>
          Linh tuyền nguyệt ảnh
        </div>
        <div style={{fontSize: 12, color: T.textMute, marginTop: 4, display:'flex', alignItems:'center', gap: 6}}>
          <span>Tu La Vũ Thần</span>
          <span style={{color: T.textFaint}}>·</span>
          <span style={{fontFamily: F.mono, fontSize: 10, color: T.jade}}>GIỌNG HỆ THỐNG · VI-VN</span>
        </div>

        {/* Per-chunk progress dots — 20 chunks */}
        <div style={{display:'flex', gap: 3, marginTop: 14, height: 4}}>
          {Array.from({length: 20}).map((_, i) => (
            <div key={i} style={{
              flex: 1, height: '100%', borderRadius: 1,
              background: i < chunkIdx ? T.jade : i === chunkIdx ? T.jade : T.hairline,
              opacity: i < chunkIdx ? 1 : i === chunkIdx ? 0.7 : 1,
              transition: 'background .3s',
            }}/>
          ))}
        </div>
        <div style={{display:'flex', justifyContent:'space-between', marginTop: 6, fontFamily: F.mono, fontSize: 10, color: T.textFaint}}>
          <span>{fmt(cur)}</span>
          <span>{chunkIdx + 1} / 20 đoạn</span>
          <span>−{fmt(totalSec - cur)}</span>
        </div>
      </div>

      {/* Transport */}
      <div style={{padding: '0 28px', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink: 0}}>
        <TransportBtn icon="M19 6l-9 6 9 6V6zM6 6h2v12H6V6z"/>
        <TransportBtn icon="M11 17l-5-5 5-5v3h7v4h-7v3z" tone={T.textMute}/>
        <button onClick={onTogglePlay} style={{
          width: 76, height: 76, borderRadius: '50%', border: 'none', cursor:'pointer',
          background: T.jade, color: T.ink,
          boxShadow: `0 0 0 6px oklch(0.74 0.11 165 / 0.12), 0 0 40px ${T.jadeGlow}`,
          display:'flex', alignItems:'center', justifyContent:'center',
        }}>
          {playing
            ? <svg width="26" height="26" viewBox="0 0 14 14" fill="currentColor"><rect x="2" y="1" width="3.5" height="12" rx="0.5"/><rect x="8.5" y="1" width="3.5" height="12" rx="0.5"/></svg>
            : <svg width="26" height="26" viewBox="0 0 14 14" fill="currentColor"><path d="M3 1l10 6-10 6V1z"/></svg>}
        </button>
        <TransportBtn icon="M13 7l5 5-5 5v-3H6v-4h7V7z" tone={T.textMute}/>
        <TransportBtn icon="M5 6l9 6-9 6V6zm11 0h2v12h-2V6z"/>
      </div>

      {/* Chip row: speed / voice / sleep / queue */}
      <div style={{padding: '16px 18px 14px', display:'flex', gap: 8, flexShrink: 0, justifyContent:'space-between'}}>
        <Chip label={speed} sub="Tốc độ" onClick={() => {
          const opts = ['0.8×','1.0×','1.25×','1.5×','2.0×'];
          setSpeed(opts[(opts.indexOf(speed)+1)%opts.length]);
        }}/>
        <Chip label="Hệ thống" sub="Giọng đọc" locked/>
        <Chip label={sleep ? '15:00' : 'Tắt'} sub="Hẹn giờ" mono active={sleep} onClick={() => setSleep(!sleep)}/>
        <Chip label="—" sub="Hàng đợi" icon="M3 7h18M3 12h12M3 17h18"/>
      </div>

      <BottomNav active="home"/>

      <style>{`
        @keyframes breathe {
          0%, 100% { opacity: 0.18; transform: scale(1); }
          50%      { opacity: 0.45; transform: scale(1.02); }
        }
      `}</style>
    </div>
  );
}

function TransportBtn({ icon, tone = T.text }) {
  return (
    <button style={{background:'none', border:'none', color: tone, cursor:'pointer', padding: 8}}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d={icon}/></svg>
    </button>
  );
}
function Chip({ label, sub, mono, active, onClick, icon, locked }) {
  return (
    <button onClick={locked ? undefined : onClick} style={{
      flex: 1, padding: '8px 4px', borderRadius: 8, cursor: locked ? 'default' : 'pointer',
      background: active ? T.jadeGlow : T.raised,
      border: `1px solid ${active ? T.jade : T.hairline}`,
      color: T.text, display:'flex', flexDirection:'column', alignItems:'center', gap: 2,
      fontFamily: F.ui, opacity: locked ? 0.85 : 1, position:'relative',
    }}>
      {icon
        ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d={icon}/></svg>
        : <span style={{fontSize: 13, fontWeight: 600, fontFamily: mono ? F.mono : F.ui, display:'flex', alignItems:'center', gap: 4}}>
            {locked && <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" style={{color: T.textFaint}}><path d="M18 8h-1V6a5 5 0 0 0-10 0v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM9 6a3 3 0 0 1 6 0v2H9V6z"/></svg>}
            {label}
          </span>}
      <span style={{fontSize: 9, color: T.textMute, letterSpacing: 0.6, textTransform:'uppercase'}}>{sub}</span>
    </button>
  );
}

// ════════════════════════════════════════════════════════════════
// READER (text mode)
// ════════════════════════════════════════════════════════════════
function ReaderScreen({ paperWarmth = 0 }) {
  // Reader stays dark (premium-dark spec) — paperWarmth tweak shifts the warmth slightly
  const paperBg = `oklch(0.20 ${0.012 + paperWarmth*0.005} ${260 - paperWarmth*120})`;
  const ink = T.text;
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%', background: paperBg, color: ink, fontFamily: F.ui}}>
      <StatusBar/>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', padding:'4px 16px 8px', flexShrink: 0}}>
        <button style={{background:'none', border:'none', color: T.text, padding: 8, cursor:'pointer'}}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 6l-6 6 6 6"/></svg>
        </button>
        <div style={{fontFamily: F.mono, fontSize: 10, color: T.textMute, letterSpacing: 1.4}}>HỒI 47 · 38%</div>
        <button style={{background:'none', border:'none', color: T.text, padding: 8, cursor:'pointer'}}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
        </button>
      </div>
      <div style={{flex:1, overflow:'auto', padding: '8px 24px 24px', minHeight: 0}}>
        <div style={{textAlign:'center', marginBottom: 18}}>
          <div style={{fontFamily: F.mono, fontSize: 9.5, color: T.textFaint, letterSpacing: 1.6, textTransform:'uppercase'}}>Hồi thứ 47</div>
          <div style={{fontFamily: F.display, fontSize: 22, fontWeight: 500, lineHeight: 1.2, marginTop: 8, color: T.text}}>
            Linh tuyền nguyệt ảnh
          </div>
          <div style={{display:'flex', alignItems:'center', justifyContent:'center', gap: 12, marginTop: 12}}>
            <span style={{flex:1, height:1, background: T.hairline, maxWidth: 60}}/>
            <span style={{fontFamily: F.display, fontSize: 14, color: T.jade}}>❖</span>
            <span style={{flex:1, height:1, background: T.hairline, maxWidth: 60}}/>
          </div>
        </div>

        <div style={{
          fontFamily: F.display, fontSize: 17, lineHeight: 1.7, color: T.textDim,
          textAlign:'justify', textIndent: '1.5em',
        }}>
          <p style={{margin: 0}}>
            <span style={{
              float:'left', fontFamily: F.display, fontSize: 56, lineHeight: 0.9,
              color: T.jade, marginRight: 8, marginTop: 6, fontWeight: 600,
            }}>T</span>
            iếng gió thổi qua ngọn núi cô tịch, mang theo hơi lạnh của trăng đêm. Trên đỉnh Linh Tuyền, thiếu niên áo trắng đứng lặng, ánh mắt sâu thẳm như vực thẳm vạn năm chưa ai dò tới.
          </p>
          <p style={{marginTop: 14}}>Hắn nâng tay, để giọt nước linh tuyền rơi xuống lòng bàn tay. Trong khoảnh khắc, một luồng linh khí thuần khiết lan tỏa, đánh thức từng tế bào trong cơ thể đang ngủ say suốt mười năm phong ấn. Một cảm giác quen thuộc, như gặp lại người tri kỷ sau bao năm xa cách, khiến khoé mắt hắn khẽ run.</p>
          <p style={{marginTop: 14}}>"Đạo tâm bất tuyệt, kiếm khí trường tồn." Tiếng tự thoại nhẹ nhàng, nhưng từng chữ như khắc vào hư không, làm cho cả ngọn núi rung động. Cánh chim vỗ rộn một vùng cây lá, bỏ lại sau lưng khoảng trời yên tĩnh đến kỳ lạ.</p>
          <p style={{marginTop: 14}}>Phía xa, một bóng người áo đỏ chậm rãi tiến tới. Bước chân không tiếng, nhưng mỗi bước đều khiến lá cây ven đường héo úa rồi rơi rụng. Ánh mắt người ấy sắc lạnh như băng, lại phảng phất một nỗi buồn sâu khôn tả.</p>
          <p style={{marginTop: 14}}>"Ai đó?" Thiếu niên không quay đầu, giọng trầm ấm, ngón tay khẽ chạm vào chuôi kiếm bên hông. Linh khí quanh người hắn bỗng nhiên ngưng đọng, như bão táp sắp bùng nổ trong khoảnh khắc tới.</p>
          <p style={{marginTop: 14}}>"Mười năm rồi, sư huynh." Giọng nữ trong trẻo vang lên sau lưng, mang theo chút run rẩy không thể giấu. "Người vẫn nhớ ta chứ?"</p>
        </div>
      </div>

      {/* Listen handoff — docked above the bottom strip */}
      <div style={{padding: '10px 16px 10px', flexShrink: 0,
                    background: `linear-gradient(180deg, transparent, ${paperBg} 40%)`}}>
        <div style={{padding: 12, borderRadius: 10, background: T.raised, border: `1px solid ${T.hairline}`,
                      display:'flex', alignItems:'center', gap: 12}}>
          <div style={{width: 34, height: 34, borderRadius: 8, background: T.jadeGlow, color: T.jade,
                        display:'flex', alignItems:'center', justifyContent:'center', flexShrink: 0}}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2a5 5 0 0 1-10 0H5z"/></svg>
          </div>
          <div style={{flex:1, minWidth: 0}}>
            <div style={{fontFamily: F.ui, fontSize: 12, fontWeight: 600, color: T.text}}>Chuyển sang nghe?</div>
            <div style={{fontFamily: F.ui, fontSize: 10.5, color: T.textMute, marginTop: 2}}>Đọc tiếp bằng giọng hệ thống từ vị trí hiện tại</div>
          </div>
          <button style={{
            background: T.jade, color: T.ink, border:'none', borderRadius: 6, fontWeight: 700,
            padding: '8px 14px', fontSize: 11, cursor:'pointer',
          }}>Nghe →</button>
        </div>
      </div>

      {/* Bottom progress strip */}
      <div style={{height: 4, background: T.hairlineSoft, flexShrink:0}}>
        <div style={{width:'38%', height:'100%', background: T.jade}}/>
      </div>
      <BottomNav active="home"/>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// PROFILE (cultivation / XP)
// ════════════════════════════════════════════════════════════════
function ProfileScreen() {
  const totalExp = 8420;
  const lvl = { num: 12, title: 'Kim Đan Trung Kỳ', color: T.yellow, min: 7500, next: 11000 };
  const progress = (totalExp - lvl.min) / (lvl.next - lvl.min);
  const realms = [
    ['Luyện Khí',          T.slate,    1, 7,  true],
    ['Trúc Cơ',             T.emerald,  8, 10, true],
    ['Kim Đan',              T.yellow,   11, 13, 'current'],
    ['Nguyên Anh',         T.orange,   14, 16, false],
    ['Hóa Thần',           T.pink,     17, 19, false],
    ['Luyện Hư',           T.violet,   20, 20, false],
    ['Hợp Thể',             T.blue,     21, 21, false],
    ['Đại Thừa',            T.blue,     22, 22, false],
    ['Độ Kiếp',              T.red,      23, 23, false],
    ['Phi Thăng Tiên Giới',T.gold,     24, 24, false],
  ];
  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%', background: T.surface, color: T.text, fontFamily: F.ui}}>
      <StatusBar/>
      <div style={{flex:1, overflow:'auto', paddingBottom: 16}}>
        {/* Header */}
        <div style={{padding: '4px 20px 0', display:'flex', alignItems:'center', justifyContent:'space-between'}}>
          <div style={{fontFamily: F.mono, fontSize: 10, color: T.textMute, letterSpacing: 1.4, textTransform:'uppercase'}}>Đạo Cung</div>
          <button style={{background:'none', border:'none', color: T.textDim, padding: 8, cursor:'pointer'}}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
        </div>

        {/* Cultivation ring */}
        <div style={{padding: '14px 20px 18px', display:'flex', flexDirection:'column', alignItems:'center'}}>
          <div style={{position:'relative', width: 180, height: 180}}>
            <svg width="180" height="180" viewBox="0 0 180 180" style={{transform:'rotate(-90deg)'}}>
              <circle cx="90" cy="90" r="78" fill="none" stroke={T.hairline} strokeWidth="3"/>
              <circle cx="90" cy="90" r="78" fill="none" stroke={lvl.color} strokeWidth="3"
                strokeDasharray={`${progress * 490} 490`} strokeLinecap="round"
                style={{filter: `drop-shadow(0 0 8px ${lvl.color})`}}/>
            </svg>
            <div style={{position:'absolute', inset: 0, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center'}}>
              <div style={{fontFamily: F.mono, fontSize: 9, color: T.textMute, letterSpacing: 1.2}}>CẤP {lvl.num}</div>
              <div style={{fontFamily: F.display, fontSize: 22, fontWeight: 500, color: lvl.color, marginTop: 4, lineHeight: 1}}>{lvl.title.split(' ')[0]} {lvl.title.split(' ')[1]}</div>
              <div style={{fontFamily: F.display, fontSize: 14, color: T.textDim, marginTop: 2}}>{lvl.title.split(' ').slice(2).join(' ')}</div>
              <div style={{fontFamily: F.mono, fontSize: 10, color: T.gold, marginTop: 8}}>{totalExp.toLocaleString()} EXP</div>
              <div style={{fontFamily: F.mono, fontSize: 9, color: T.textFaint, marginTop: 2}}>{(lvl.next - totalExp).toLocaleString()} đến cấp tiếp</div>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div style={{padding: '0 20px 18px', display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap: 8}}>
          {[['324','đã nghe'],['189','đã đọc'],['12','tu luyện'],['7','hoàn thành']].map(([n,l],i) => (
            <div key={i} style={{
              background: T.raised, border: `1px solid ${T.hairline}`, borderRadius: 8,
              padding: '10px 6px', textAlign:'center',
            }}>
              <div style={{fontFamily: F.display, fontSize: 19, fontWeight: 500, color: T.text}}>{n}</div>
              <div style={{fontFamily: F.mono, fontSize: 8.5, color: T.textMute, letterSpacing: 0.6, textTransform:'uppercase', marginTop: 2}}>{l}</div>
            </div>
          ))}
        </div>

        {/* Realm progression */}
        <div style={{padding: '0 20px'}}>
          <div style={{fontFamily: F.display, fontSize: 17, fontWeight: 500, marginBottom: 10}}>Đạo lộ tiến giai</div>
          <div style={{position:'relative', paddingLeft: 16}}>
            <div style={{position:'absolute', left: 4, top: 8, bottom: 8, width: 1, background: T.hairline}}/>
            {realms.map((r, i) => {
              const [name, color, lo, hi, status] = r;
              const cur = status === 'current';
              const done = status === true;
              return (
                <div key={i} style={{display:'flex', alignItems:'center', gap: 12, padding: '8px 0', position:'relative'}}>
                  <div style={{
                    position:'absolute', left:-16, top: '50%', transform:'translateY(-50%)',
                    width: 9, height: 9, borderRadius: '50%',
                    background: cur ? color : done ? color : T.surface,
                    border: `2px solid ${cur || done ? color : T.hairline}`,
                    boxShadow: cur ? `0 0 12px ${color}` : 'none',
                  }}/>
                  <div style={{flex:1, opacity: !done && !cur ? 0.5 : 1}}>
                    <div style={{display:'flex', alignItems:'baseline', gap: 8}}>
                      <span style={{fontFamily: F.display, fontSize: 14, fontWeight: 500, color: cur ? color : T.text}}>{name}</span>
                      <span style={{fontFamily: F.mono, fontSize: 9, color: T.textFaint}}>Cấp {lo === hi ? lo : `${lo}–${hi}`}</span>
                    </div>
                  </div>
                  {cur && <span style={{fontFamily: F.mono, fontSize: 9, color: color, padding: '3px 7px', background: `${color.replace(')', ' / 0.15)')}`, borderRadius: 100, letterSpacing: 0.5}}>HIỆN TẠI</span>}
                  {done && <span style={{fontFamily: F.mono, fontSize: 9, color: T.textFaint}}>✓</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <BottomNav active="profile"/>
    </div>
  );
}

// Export everything
Object.assign(window, {
  T, F,
  LibraryScreen, BookDetailScreen, PlayerScreen, ReaderScreen, ProfileScreen,
});
