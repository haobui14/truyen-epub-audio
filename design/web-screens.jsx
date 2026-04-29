// web-screens.jsx — Desktop web layout for TruyệnAudio
// Reuses T (palette) and F (fonts) plus Cover from screens.jsx (already on window).
// Layout pattern: left rail nav · top search bar · content grid · persistent bottom mini-player.

const W_W = 1440;
const W_H = 900;

// ──────────────────────────────────────────────────────────
// Sidebar
// ──────────────────────────────────────────────────────────
function WebSidebar({ active = 'home' }) {
  const item = (key, label, sub, d) => {
    const isActive = active === key;
    return (
      <div key={key} style={{
        display:'flex', alignItems:'center', gap: 12, padding: '10px 14px',
        borderRadius: 8, cursor:'pointer',
        background: isActive ? T.jadeGlow : 'transparent',
        color: isActive ? T.text : T.textDim,
        position:'relative',
      }}>
        {isActive && <span style={{position:'absolute', left: -16, top: 10, bottom: 10, width: 2, background: T.jade, borderRadius: 1}}/>}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d={d}/>
        </svg>
        <div style={{minWidth: 0, flex:1}}>
          <div style={{fontSize: 13, fontWeight: isActive ? 600 : 500, fontFamily: F.ui}}>{label}</div>
          {sub && <div style={{fontSize: 9.5, color: T.textFaint, fontFamily: F.mono, letterSpacing: 0.6, marginTop: 1, textTransform:'uppercase'}}>{sub}</div>}
        </div>
      </div>
    );
  };

  return (
    <aside style={{
      width: 240, background: T.ink, borderRight: `1px solid ${T.hairline}`,
      display:'flex', flexDirection:'column', flexShrink: 0,
    }}>
      {/* Brand */}
      <div style={{padding: '20px 22px 16px', display:'flex', alignItems:'center', gap: 10}}>
        <div style={{
          width: 32, height: 32, borderRadius: 7, background: T.jade, color: T.ink,
          display:'flex', alignItems:'center', justifyContent:'center',
          fontFamily: F.display, fontSize: 18, fontWeight: 700,
          boxShadow: `0 0 14px ${T.jadeGlow}`,
        }}>藏</div>
        <div style={{minWidth:0}}>
          <div style={{fontFamily: F.display, fontSize: 17, fontWeight: 600, color: T.text, lineHeight: 1}}>TruyệnAudio</div>
          <div style={{fontFamily: F.mono, fontSize: 9, color: T.textFaint, letterSpacing: 1, marginTop: 3}}>v3.0 · WEB</div>
        </div>
      </div>

      {/* Primary nav */}
      <div style={{padding: '0 16px 8px', display:'flex', flexDirection:'column', gap: 2}}>
        <div style={{fontFamily: F.mono, fontSize: 9, color: T.textFaint, letterSpacing: 1.4, padding: '12px 14px 6px', textTransform:'uppercase'}}>Khám phá</div>
        {item('home',     'Trang chủ',     null, 'M3 12l9-9 9 9M5 10v10h14V10')}
        {item('discover', 'Khám phá',      null, 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0')}
        {item('rank',     'Bảng xếp hạng', null, 'M3 3v18h18M7 14l4-4 4 4 5-7')}
        {item('genres',   'Thể loại',      null, 'M4 6h16M4 12h16M4 18h16')}
      </div>

      <div style={{padding: '0 16px 8px', display:'flex', flexDirection:'column', gap: 2}}>
        <div style={{fontFamily: F.mono, fontSize: 9, color: T.textFaint, letterSpacing: 1.4, padding: '12px 14px 6px', textTransform:'uppercase'}}>Của tôi</div>
        {item('library',  'Tủ sách',         '24 truyện',  'M4 4h6v16H4zM14 4h6v16h-6z')}
        {item('history',  'Lịch sử',         null,          'M12 8v4l3 2M3 12a9 9 0 109-9')}
        {item('downloads','Đã tải',           '8 chương',   'M12 3v12m0 0l-4-4m4 4l4-4M5 21h14')}
        {item('profile',  'Cá nhân',         'Cấp 12',      'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0')}
      </div>

      <div style={{padding: '0 16px', display:'flex', flexDirection:'column', gap: 2}}>
        <div style={{fontFamily: F.mono, fontSize: 9, color: T.textFaint, letterSpacing: 1.4, padding: '12px 14px 6px', textTransform:'uppercase'}}>Bộ sưu tập</div>
        {[['Tu tiên đêm khuya', T.violet], ['Nghe khi lái xe', T.blue], ['Truyện ngắn hay', T.jade]].map(([n,c]) => (
          <div key={n} style={{display:'flex', alignItems:'center', gap: 12, padding: '8px 14px', borderRadius: 8, cursor:'pointer', color: T.textDim}}>
            <span style={{width: 8, height: 8, borderRadius: 2, background: c, flexShrink: 0}}/>
            <span style={{fontSize: 12.5, fontFamily: F.ui}}>{n}</span>
          </div>
        ))}
        <button style={{
          marginTop: 4, padding: '8px 14px', display:'flex', alignItems:'center', gap: 10,
          background: 'none', border: 'none', color: T.textMute,
          fontSize: 12, fontFamily: F.ui, cursor:'pointer', textAlign:'left',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
          Tạo mới
        </button>
      </div>

      <div style={{flex: 1}}/>

      {/* Footer cultivation card */}
      <div style={{margin: 16, padding: 14, borderRadius: 10, background: T.raised, border: `1px solid ${T.hairline}`}}>
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
          <div style={{fontFamily: F.mono, fontSize: 9, color: T.textFaint, letterSpacing: 1.2, textTransform:'uppercase'}}>Cảnh giới</div>
          <div style={{fontFamily: F.mono, fontSize: 9, color: T.gold}}>LV.12</div>
        </div>
        <div style={{fontFamily: F.display, fontSize: 14, fontWeight: 500, color: T.gold, marginTop: 4}}>Kim Đan Trung Kỳ</div>
        <div style={{marginTop: 8, height: 3, background: T.hairlineSoft, borderRadius: 2}}>
          <div style={{height:'100%', width:'62%', background: T.gold, borderRadius: 2}}/>
        </div>
        <div style={{fontFamily: F.mono, fontSize: 9, color: T.textMute, marginTop: 5}}>2,580 / 11,000 EXP</div>
      </div>
    </aside>
  );
}

// ──────────────────────────────────────────────────────────
// Top bar
// ──────────────────────────────────────────────────────────
function WebTopBar({ search = '', setSearch }) {
  return (
    <div style={{
      height: 60, padding: '0 28px',
      display:'flex', alignItems:'center', gap: 18,
      borderBottom: `1px solid ${T.hairline}`, flexShrink: 0,
      background: T.surface,
    }}>
      <div style={{display:'flex', gap: 6}}>
        <button style={{
          width: 30, height: 30, borderRadius: 6, border: `1px solid ${T.hairline}`,
          background: T.raised, color: T.textDim, cursor:'pointer',
          display:'flex', alignItems:'center', justifyContent:'center',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 6l-6 6 6 6"/></svg>
        </button>
        <button style={{
          width: 30, height: 30, borderRadius: 6, border: `1px solid ${T.hairline}`,
          background: T.raised, color: T.textFaint, cursor:'pointer',
          display:'flex', alignItems:'center', justifyContent:'center',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 6l6 6-6 6"/></svg>
        </button>
      </div>

      {/* Search */}
      <div style={{
        flex: 1, maxWidth: 520, height: 36, borderRadius: 8,
        background: T.raised, border: `1px solid ${T.hairline}`,
        display:'flex', alignItems:'center', gap: 10, padding: '0 14px',
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={T.textMute} strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
        <input
          value={search}
          onChange={e => setSearch && setSearch(e.target.value)}
          placeholder="Tìm truyện, tác giả, hoặc thể loại…"
          style={{
            flex: 1, background:'transparent', border:'none', outline:'none',
            color: T.text, fontFamily: F.ui, fontSize: 13,
          }}
        />
        <kbd style={{
          fontFamily: F.mono, fontSize: 10, color: T.textMute,
          padding: '2px 6px', borderRadius: 4, border: `1px solid ${T.hairline}`, background: T.ink,
        }}>⌘K</kbd>
      </div>

      <div style={{flex: 1}}/>

      {/* Right actions */}
      <button style={{
        height: 32, padding: '0 14px', borderRadius: 8,
        background: 'transparent', border: `1px solid ${T.hairline}`, color: T.textDim,
        fontFamily: F.ui, fontSize: 12, fontWeight: 500, cursor:'pointer',
        display:'flex', alignItems:'center', gap: 8,
      }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v18m9-9H3"/></svg>
        Nhập truyện
      </button>
      <button style={{
        width: 32, height: 32, borderRadius: 8, position:'relative',
        background: 'transparent', border: `1px solid ${T.hairline}`, color: T.textDim,
        cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M14 21a2 2 0 01-4 0"/></svg>
        <span style={{position:'absolute', top: 6, right: 6, width: 6, height: 6, borderRadius: 3, background: T.jade}}/>
      </button>
      <div style={{
        width: 32, height: 32, borderRadius: '50%',
        background: `linear-gradient(135deg, ${T.jade}, ${T.gold})`,
        color: T.ink, display:'flex', alignItems:'center', justifyContent:'center',
        fontFamily: F.display, fontWeight: 700, fontSize: 13, cursor:'pointer',
      }}>H</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Mini player (persistent bottom bar)
// ──────────────────────────────────────────────────────────
function WebMiniPlayer({ playing, onTogglePlay, onOpenPlayer }) {
  return (
    <div style={{
      height: 80, background: T.ink, borderTop: `1px solid ${T.hairline}`,
      display:'grid', gridTemplateColumns: '1fr 2fr 1fr', alignItems:'center',
      padding: '0 24px', gap: 24, flexShrink: 0,
    }}>
      {/* Now playing */}
      <div onClick={onOpenPlayer} style={{display:'flex', alignItems:'center', gap: 14, cursor:'pointer', minWidth: 0}}>
        <Cover w={52} h={52} hue={150} seed={11} label="Tiên" radius={6}/>
        <div style={{minWidth: 0}}>
          <div style={{fontFamily: F.display, fontSize: 14, fontWeight: 500, color: T.text, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>
            Linh tuyền nguyệt ảnh
          </div>
          <div style={{fontFamily: F.ui, fontSize: 11, color: T.textMute, marginTop: 2, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>
            Tiên Nghịch · Hồi 47 / 124
          </div>
        </div>
        <button style={{
          background:'none', border:'none', color: T.jade, padding: 6, cursor:'pointer', flexShrink: 0,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
        </button>
      </div>

      {/* Transport + scrubber */}
      <div style={{display:'flex', flexDirection:'column', alignItems:'center', gap: 6}}>
        <div style={{display:'flex', alignItems:'center', gap: 18}}>
          <button style={transportBtn(T.textMute)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 18V6m-4 6L4 6v12l8-6z"/></svg>
          </button>
          <button style={transportBtn(T.textDim)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 17l-5-5 5-5v3h7v4h-7v3z"/></svg>
          </button>
          <button onClick={onTogglePlay} style={{
            width: 36, height: 36, borderRadius:'50%', border:'none', cursor:'pointer',
            background: T.jade, color: T.ink,
            display:'flex', alignItems:'center', justifyContent:'center',
            boxShadow: `0 0 18px ${T.jadeGlow}`,
          }}>
            {playing
              ? <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
              : <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{marginLeft: 2}}><path d="M5 3l16 9-16 9V3z"/></svg>}
          </button>
          <button style={transportBtn(T.textDim)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 7l5 5-5 5v-3H6v-4h7V7z"/></svg>
          </button>
          <button style={transportBtn(T.textMute)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6v12m4-6L20 6v12l-8-6z"/></svg>
          </button>
        </div>
        <div style={{display:'flex', alignItems:'center', gap: 10, width:'100%'}}>
          <span style={{fontFamily: F.mono, fontSize: 10, color: T.textMute, minWidth: 36, textAlign:'right'}}>14:32</span>
          <div style={{flex:1, height: 3, background: T.hairlineSoft, borderRadius: 2, position:'relative'}}>
            <div style={{height:'100%', width: '38%', background: T.jade, borderRadius: 2}}/>
            <div style={{position:'absolute', left:'38%', top:'50%', transform:'translate(-50%,-50%)', width: 10, height: 10, borderRadius: 5, background: T.jade, boxShadow: `0 0 8px ${T.jadeGlow}`}}/>
          </div>
          <span style={{fontFamily: F.mono, fontSize: 10, color: T.textMute, minWidth: 36}}>38:12</span>
        </div>
      </div>

      {/* Right controls */}
      <div style={{display:'flex', alignItems:'center', gap: 10, justifyContent:'flex-end'}}>
        <button style={chipBtn()}>1.0×</button>
        <button style={chipBtn()}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 5h2v6h-2zm0 8h2v2h-2z"/></svg>
          15p
        </button>
        <button style={iconBtn()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M3 6h18M3 18h12"/></svg>
        </button>
        <div style={{display:'flex', alignItems:'center', gap: 6, marginLeft: 4}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={T.textMute} strokeWidth="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 010 7"/></svg>
          <div style={{width: 70, height: 3, background: T.hairlineSoft, borderRadius: 2}}>
            <div style={{height:'100%', width:'70%', background: T.textDim, borderRadius: 2}}/>
          </div>
        </div>
      </div>
    </div>
  );
}

const transportBtn = (color) => ({
  background:'none', border:'none', color, padding: 4, cursor:'pointer',
  display:'flex', alignItems:'center', justifyContent:'center',
});
const chipBtn = () => ({
  height: 26, padding: '0 10px', borderRadius: 6,
  background: T.raised, border: `1px solid ${T.hairline}`,
  color: T.textDim, fontFamily: F.mono, fontSize: 10.5, fontWeight: 600,
  cursor:'pointer', display:'flex', alignItems:'center', gap: 5,
  letterSpacing: 0.4,
});
const iconBtn = () => ({
  width: 28, height: 28, borderRadius: 6,
  background: 'transparent', border: 'none',
  color: T.textMute, cursor:'pointer',
  display:'flex', alignItems:'center', justifyContent:'center',
});

// ──────────────────────────────────────────────────────────
// HOME / Library content
// ──────────────────────────────────────────────────────────
function WebHomeContent() {
  // Match the mobile data shape
  const continuing = [
    { t: 'Tiên Nghịch',           ch: 47,  total: 124, hue: 150, seed: 11 },
    { t: 'Phàm Nhân Tu Tiên',     ch: 312, total: 540, hue: 200, seed: 22 },
    { t: 'Đấu Phá Thương Khung',  ch: 89,  total: 200, hue: 30,  seed: 33 },
    { t: 'Vũ Động Càn Khôn',      ch: 156, total: 280, hue: 280, seed: 44 },
  ];
  const trending = [
    { t: 'Tu La Vũ Thần',         author: 'Thiện Lương',    listens: '2.4M', hue: 350, seed: 55 },
    { t: 'Hoàn Mỹ Thế Giới',      author: 'Thần Đông',      listens: '1.8M', hue: 220, seed: 66 },
    { t: 'Già Thiên',             author: 'Thần Đông',      listens: '1.5M', hue: 50,  seed: 77 },
    { t: 'Trạch Thiên Ký',        author: 'Mèo Lười',       listens: '980K', hue: 180, seed: 88 },
    { t: 'Linh Vũ Thiên Hạ',      author: 'Vũ Phong',       listens: '720K', hue: 120, seed: 99 },
  ];
  const genres = [
    { name: 'Tiên Hiệp',     count: 248, hue: 165 },
    { name: 'Huyền Huyễn',   count: 312, hue: 280 },
    { name: 'Đô Thị',        count: 156, hue: 30  },
    { name: 'Khoa Huyễn',    count: 92,  hue: 220 },
    { name: 'Ngôn Tình',     count: 184, hue: 350 },
    { name: 'Lịch Sử',       count: 67,  hue: 50  },
  ];

  return (
    <div style={{padding: '24px 32px 32px', overflow:'auto', flex: 1}}>
      {/* Greeting */}
      <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom: 24}}>
        <div>
          <div style={{fontFamily: F.mono, fontSize: 10, color: T.textFaint, letterSpacing: 1.4, textTransform:'uppercase', marginBottom: 6}}>Chào buổi tối</div>
          <div style={{fontFamily: F.display, fontSize: 32, fontWeight: 500, color: T.text, lineHeight: 1.1}}>Sẵn sàng nghe tiếp, Hào?</div>
        </div>
        <div style={{display:'flex', gap: 8}}>
          <button style={{...chipBtn(), height: 32, fontSize: 11, fontFamily: F.ui, fontWeight: 500, color: T.textDim, padding: '0 14px'}}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2a5 5 0 0 1-10 0H5z"/></svg>
            Đang nghe
          </button>
          <button style={{...chipBtn(), height: 32, fontSize: 11, fontFamily: F.ui, fontWeight: 500, color: T.textDim, padding: '0 14px'}}>
            Mới nhất
          </button>
        </div>
      </div>

      {/* Continue listening — featured + small cards */}
      <SectionHeader title="Nghe tiếp" sub="Continue · 4 truyện đang dở"/>
      <div style={{display:'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 16, marginBottom: 36}}>
        {/* Featured first card */}
        <FeaturedCard book={continuing[0]}/>
        {continuing.slice(1).map((b,i) => <ContinueCard key={i} book={b}/>)}
      </div>

      {/* Trending row */}
      <SectionHeader title="Phong vân hội tụ" sub="Top 10 · Trending now"/>
      <div style={{display:'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 18, marginBottom: 36}}>
        {trending.map((b,i) => <TrendingCard key={i} rank={i+1} book={b}/>)}
      </div>

      {/* Genres */}
      <SectionHeader title="Thể loại" sub="Browse by genre"/>
      <div style={{display:'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12}}>
        {genres.map((g,i) => <GenreTile key={i} g={g}/>)}
      </div>
    </div>
  );
}

function SectionHeader({ title, sub }) {
  return (
    <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom: 14}}>
      <div style={{display:'flex', alignItems:'baseline', gap: 14}}>
        <h2 style={{fontFamily: F.display, fontSize: 22, fontWeight: 500, color: T.text, margin: 0}}>{title}</h2>
        <span style={{fontFamily: F.mono, fontSize: 10, color: T.textFaint, letterSpacing: 1, textTransform:'uppercase'}}>{sub}</span>
      </div>
      <button style={{background:'none', border:'none', color: T.jade, fontFamily: F.ui, fontSize: 12, fontWeight: 600, cursor:'pointer'}}>Xem tất cả →</button>
    </div>
  );
}

function FeaturedCard({ book }) {
  const pct = Math.round(book.ch / book.total * 100);
  return (
    <div style={{
      gridRow: 'span 1',
      borderRadius: 12,
      background: `linear-gradient(135deg, oklch(0.30 0.06 165) 0%, ${T.raised} 70%)`,
      border: `1px solid ${T.hairline}`,
      padding: 18, display:'flex', gap: 18, position:'relative', overflow:'hidden', cursor:'pointer',
    }}>
      <div style={{
        position:'absolute', right: -40, top: -40, width: 200, height: 200,
        borderRadius: '50%', background: T.jadeGlow, filter: 'blur(40px)',
      }}/>
      <Cover w={130} h={180} hue={book.hue} seed={book.seed} label={book.t.split(' ')[0]} radius={8}/>
      <div style={{flex: 1, minWidth: 0, display:'flex', flexDirection:'column', justifyContent:'space-between', position:'relative'}}>
        <div>
          <div style={{fontFamily: F.mono, fontSize: 9.5, color: T.jade, letterSpacing: 1.4, textTransform:'uppercase', marginBottom: 8}}>Đang nghe · 38%</div>
          <div style={{fontFamily: F.display, fontSize: 24, fontWeight: 500, color: T.text, lineHeight: 1.1}}>{book.t}</div>
          <div style={{fontFamily: F.ui, fontSize: 12, color: T.textMute, marginTop: 6}}>Hồi {book.ch} · Linh tuyền nguyệt ảnh · 27 phút còn lại</div>
        </div>
        <div>
          <div style={{height: 3, background: T.hairlineSoft, borderRadius: 2, marginBottom: 14}}>
            <div style={{height:'100%', width: `${pct}%`, background: T.jade, borderRadius: 2}}/>
          </div>
          <div style={{display:'flex', gap: 10}}>
            <button style={{
              height: 38, padding: '0 22px', borderRadius: 8, border:'none', cursor:'pointer',
              background: T.jade, color: T.ink, fontFamily: F.ui, fontWeight: 700, fontSize: 13,
              display:'flex', alignItems:'center', gap: 8,
              boxShadow: `0 0 24px ${T.jadeGlow}`,
            }}>
              <svg width="11" height="11" viewBox="0 0 14 14" fill="currentColor"><path d="M3 1l10 6-10 6V1z"/></svg>
              Tiếp tục nghe
            </button>
            <button style={{
              height: 38, padding: '0 16px', borderRadius: 8, cursor:'pointer',
              background:'transparent', border: `1px solid ${T.hairline}`, color: T.textDim,
              fontFamily: F.ui, fontWeight: 600, fontSize: 12,
            }}>Đọc văn bản</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ContinueCard({ book }) {
  const pct = Math.round(book.ch / book.total * 100);
  return (
    <div style={{
      borderRadius: 10, padding: 14, cursor:'pointer',
      background: T.raised, border: `1px solid ${T.hairline}`,
      display:'flex', flexDirection:'column', gap: 10,
    }}>
      <Cover w={'100%'} h={150} hue={book.hue} seed={book.seed} label={book.t.split(' ')[0]} radius={6}/>
      <div style={{minWidth: 0}}>
        <div style={{fontFamily: F.display, fontSize: 14, fontWeight: 500, color: T.text, lineHeight: 1.2, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{book.t}</div>
        <div style={{fontFamily: F.mono, fontSize: 9.5, color: T.textMute, letterSpacing: 0.6, marginTop: 4, textTransform:'uppercase'}}>Hồi {book.ch}/{book.total} · {pct}%</div>
      </div>
      <div style={{height: 2, background: T.hairlineSoft, borderRadius: 1}}>
        <div style={{height:'100%', width: `${pct}%`, background: T.jadeDim, borderRadius: 1}}/>
      </div>
    </div>
  );
}

function TrendingCard({ rank, book }) {
  return (
    <div style={{cursor:'pointer'}}>
      <div style={{position:'relative'}}>
        <Cover w={'100%'} h={240} hue={book.hue} seed={book.seed} label={book.t.split(' ')[0]} radius={8}/>
        <div style={{
          position:'absolute', top: 8, left: 8,
          width: 26, height: 26, borderRadius: 6,
          background: 'rgba(0,0,0,0.7)', backdropFilter:'blur(8px)',
          color: T.gold, fontFamily: F.display, fontWeight: 700, fontSize: 13,
          display:'flex', alignItems:'center', justifyContent:'center',
        }}>{rank}</div>
        <button style={{
          position:'absolute', bottom: 10, right: 10,
          width: 36, height: 36, borderRadius:'50%', border:'none', cursor:'pointer',
          background: T.jade, color: T.ink,
          display:'flex', alignItems:'center', justifyContent:'center',
          boxShadow: `0 0 16px ${T.jadeGlow}`,
        }}>
          <svg width="11" height="11" viewBox="0 0 14 14" fill="currentColor"><path d="M3 1l10 6-10 6V1z"/></svg>
        </button>
      </div>
      <div style={{marginTop: 10}}>
        <div style={{fontFamily: F.display, fontSize: 14, fontWeight: 500, color: T.text, lineHeight: 1.2, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{book.t}</div>
        <div style={{fontFamily: F.ui, fontSize: 11, color: T.textMute, marginTop: 3, display:'flex', justifyContent:'space-between'}}>
          <span style={{whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{book.author}</span>
          <span style={{fontFamily: F.mono, color: T.textFaint, flexShrink: 0, marginLeft: 8}}>{book.listens}</span>
        </div>
      </div>
    </div>
  );
}

function GenreTile({ g }) {
  return (
    <div style={{
      height: 90, borderRadius: 10, padding: 14, cursor:'pointer',
      background: `linear-gradient(135deg, oklch(0.32 0.08 ${g.hue}) 0%, ${T.raised} 80%)`,
      border: `1px solid ${T.hairline}`,
      display:'flex', flexDirection:'column', justifyContent:'space-between',
      position:'relative', overflow:'hidden',
    }}>
      <div style={{fontFamily: F.display, fontSize: 17, fontWeight: 500, color: T.text}}>{g.name}</div>
      <div style={{fontFamily: F.mono, fontSize: 10, color: T.textMute, letterSpacing: 0.6, textTransform:'uppercase'}}>{g.count} truyện</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// PLAYER content (full-screen player / book detail combined)
// Two-column: large cover & metadata on left, chapter list on right
// ──────────────────────────────────────────────────────────
function WebPlayerContent({ playing, onTogglePlay }) {
  const chapters = Array.from({length: 14}, (_, i) => {
    const num = 44 + i;
    const titles = [
      'Cố nhân tương kiến','Hồng y tà ma','Linh tuyền nguyệt ảnh','Kiếm khí trường tồn',
      'Đỉnh phong giao chiến','Phong ấn giải trừ','Đạo tâm vô ngại','Cửu thiên thập địa',
      'Tử khí đông lai','Vô lượng kiếp ba','Thiên cơ huyền diệu','Thái sơ chí tôn',
      'Vạn pháp quy nhất','Thiên đạo tuần hoàn',
    ];
    return { i: num, t: titles[i], dur: `${(38 + (i*7)%18).toString().padStart(2,'0')}:${((i*13)%60).toString().padStart(2,'0')}` };
  });
  const playingIdx = 3;

  return (
    <div style={{display:'grid', gridTemplateColumns: '420px 1fr', gap: 32, padding: '32px 36px', overflow:'auto', flex: 1}}>
      {/* LEFT — hero */}
      <div>
        <div style={{position:'relative'}}>
          <Cover w={420} h={560} hue={150} seed={11} label="Tiên" radius={10}/>
          <div style={{
            position:'absolute', top: 16, right: 16,
            width: 42, height: 42, borderRadius: 4,
            background: 'oklch(0.40 0.18 27)', color: T.text,
            fontFamily: F.display, fontWeight: 700, fontSize: 22,
            display:'flex', alignItems:'center', justifyContent:'center',
            transform: 'rotate(-6deg)',
            boxShadow: 'inset 0 0 0 2px oklch(0.55 0.18 27), 0 2px 6px rgba(0,0,0,0.5)',
          }}>聽</div>
        </div>
        <div style={{marginTop: 22}}>
          <div style={{fontFamily: F.mono, fontSize: 10, color: T.jade, letterSpacing: 1.4, textTransform:'uppercase'}}>Đang phát · Hồi 47</div>
          <div style={{fontFamily: F.display, fontSize: 32, fontWeight: 500, color: T.text, lineHeight: 1.1, marginTop: 6}}>Tiên Nghịch</div>
          <div style={{fontFamily: F.ui, fontSize: 13, color: T.textMute, marginTop: 6}}>
            Nhĩ Căn · 124 hồi · Tiên hiệp / Phàm nhân lưu
          </div>

          {/* meta strip */}
          <div style={{display:'flex', gap: 18, marginTop: 18, paddingTop: 18, borderTop: `1px solid ${T.hairline}`}}>
            {[['4.9','★ Đánh giá'],['2.4M','Lượt nghe'],['38%','Tiến độ']].map(([n,l],i) => (
              <div key={i} style={{flex:1}}>
                <div style={{fontFamily: F.display, fontSize: 18, fontWeight: 500, color: T.text}}>{n}</div>
                <div style={{fontFamily: F.mono, fontSize: 9, color: T.textMute, letterSpacing: 0.8, textTransform:'uppercase', marginTop: 2}}>{l}</div>
              </div>
            ))}
          </div>

          {/* synopsis */}
          <div style={{marginTop: 20}}>
            <div style={{fontFamily: F.mono, fontSize: 9, color: T.textFaint, letterSpacing: 1.4, textTransform:'uppercase', marginBottom: 8}}>Tóm tắt</div>
            <div style={{fontFamily: F.display, fontSize: 14, lineHeight: 1.6, color: T.textDim}}>
              Vương Lâm, một thiếu niên bình phàm xuất thân ở thôn quê nghèo khó, vô tình được Hằng Nhạc Tông thu nhận. Trên con đường tu tiên đầy gian khổ, hắn dùng ý chí kiên cường và đạo tâm bất khuất, nghịch thiên cải mệnh, từng bước trở thành đại năng vô địch.
            </div>
          </div>

          {/* tags */}
          <div style={{display:'flex', gap: 6, flexWrap:'wrap', marginTop: 16}}>
            {['Tiên hiệp','Phàm nhân lưu','Trường thiên','Tiến hóa','Báo thù'].map(t => (
              <span key={t} style={{
                padding: '5px 10px', borderRadius: 100, fontSize: 11, fontWeight: 500,
                background: T.raised, border: `1px solid ${T.hairline}`, color: T.textDim, fontFamily: F.ui,
              }}>{t}</span>
            ))}
          </div>
        </div>
      </div>

      {/* RIGHT — chapter list */}
      <div>
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 16}}>
          <div>
            <h2 style={{fontFamily: F.display, fontSize: 22, fontWeight: 500, color: T.text, margin: 0}}>Mục lục</h2>
            <div style={{fontFamily: F.mono, fontSize: 10, color: T.textFaint, letterSpacing: 1, textTransform:'uppercase', marginTop: 4}}>124 hồi · 47 đã nghe</div>
          </div>
          <div style={{display:'flex', gap: 8}}>
            <button style={chipBtn()}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h18M6 12h12m-9 5h6"/></svg>
              Sắp xếp
            </button>
            <button style={chipBtn()}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
              Tìm hồi
            </button>
            <button style={chipBtn()}>Tải xuống</button>
          </div>
        </div>

        <div style={{borderRadius: 10, border: `1px solid ${T.hairline}`, background: T.raised, overflow:'hidden'}}>
          {chapters.map((c, idx) => {
            const isPlaying = idx === playingIdx;
            const done = idx < playingIdx;
            return (
              <div key={c.i} style={{
                display:'grid', gridTemplateColumns: '40px 1fr 80px 80px 40px',
                alignItems:'center', gap: 14,
                padding: '12px 16px',
                borderBottom: idx < chapters.length-1 ? `1px solid ${T.hairlineSoft}` : 'none',
                background: isPlaying ? T.jadeGlow : 'transparent',
                cursor:'pointer', opacity: done ? 0.55 : 1,
              }}>
                <div style={{
                  fontFamily: F.mono, fontSize: 11, color: isPlaying ? T.jade : T.textFaint, fontWeight: isPlaying ? 700 : 500,
                  letterSpacing: 0.6,
                }}>
                  {isPlaying
                    ? <PlayingBars/>
                    : (done ? '✓' : c.i.toString().padStart(3,'0'))}
                </div>
                <div style={{minWidth: 0}}>
                  <div style={{
                    fontFamily: F.display, fontSize: 14, fontWeight: isPlaying ? 600 : 500,
                    color: isPlaying ? T.text : T.textDim, lineHeight: 1.2,
                  }}>
                    Hồi {c.i} · {c.t}
                  </div>
                  {isPlaying && <div style={{fontFamily: F.mono, fontSize: 10, color: T.jade, marginTop: 3, letterSpacing: 0.6, textTransform:'uppercase'}}>Đang phát · 38%</div>}
                </div>
                <div style={{fontFamily: F.mono, fontSize: 11, color: T.textMute, textAlign:'right'}}>{c.dur}</div>
                <div style={{fontFamily: F.mono, fontSize: 10, color: T.textFaint, textAlign:'right'}}>
                  {idx % 3 === 0 ? '↓' : ''}
                </div>
                <div style={{display:'flex', justifyContent:'center'}}>
                  <button style={{
                    width: 26, height: 26, borderRadius: '50%',
                    border: `1px solid ${isPlaying ? T.jade : T.hairline}`,
                    background: 'transparent', color: isPlaying ? T.jade : T.textMute,
                    display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer',
                  }}>
                    {isPlaying
                      ? <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
                      : <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" style={{marginLeft: 1}}><path d="M5 3l16 9-16 9V3z"/></svg>}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PlayingBars() {
  return (
    <div style={{display:'flex', alignItems:'flex-end', gap: 2, height: 14, justifyContent:'center'}}>
      {[8, 12, 6, 10].map((h, i) => (
        <span key={i} style={{
          width: 2, height: h, background: T.jade, borderRadius: 1,
          animation: `playingBar 1.2s ease-in-out ${i*0.15}s infinite`,
        }}/>
      ))}
      <style>{`@keyframes playingBar { 0%,100% { transform: scaleY(0.5); } 50% { transform: scaleY(1); } }`}</style>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Compose the desktop screens
// ──────────────────────────────────────────────────────────
function WebHomeScreen({ playing, onTogglePlay }) {
  const [search, setSearch] = React.useState('');
  return (
    <div style={{
      width: W_W, height: W_H, background: T.surface, color: T.text,
      display:'flex', overflow:'hidden', fontFamily: F.ui,
    }}>
      <WebSidebar active="home"/>
      <div style={{flex: 1, display:'flex', flexDirection:'column', minWidth: 0}}>
        <WebTopBar search={search} setSearch={setSearch}/>
        <WebHomeContent/>
        <WebMiniPlayer playing={playing} onTogglePlay={onTogglePlay}/>
      </div>
    </div>
  );
}

function WebPlayerScreenFull({ playing, onTogglePlay }) {
  const [search, setSearch] = React.useState('');
  return (
    <div style={{
      width: W_W, height: W_H, background: T.surface, color: T.text,
      display:'flex', overflow:'hidden', fontFamily: F.ui,
    }}>
      <WebSidebar active="library"/>
      <div style={{flex: 1, display:'flex', flexDirection:'column', minWidth: 0}}>
        <WebTopBar search={search} setSearch={setSearch}/>
        <WebPlayerContent playing={playing} onTogglePlay={onTogglePlay}/>
        <WebMiniPlayer playing={playing} onTogglePlay={onTogglePlay}/>
      </div>
    </div>
  );
}

Object.assign(window, {
  WebHomeScreen, WebPlayerScreenFull, W_W, W_H,
});
