// web-admin.jsx — Admin pages for TruyệnAudio (Manage Books, Edit Book, Edit Chapter)
// Reuses T (palette), F (fonts), Cover, WebSidebar from window globals.
// Admin role is gated server-side; these screens never appear for normal users.

const A_W = 1480;
const A_H = 1020;

// ─── Shared admin chrome ───────────────────────────────────────
function AdminSidebar({ active = 'books' }) {
  const item = (key, label, sub, d) => {
    const isOn = active === key;
    return (
      <div key={key} style={{
        display:'flex', alignItems:'center', gap: 12, padding: '10px 14px',
        borderRadius: 8, cursor:'pointer',
        background: isOn ? T.jadeGlow : 'transparent',
        color: isOn ? T.text : T.textDim,
        position:'relative',
      }}>
        {isOn && <span style={{position:'absolute', left:-16, top:10, bottom:10, width:2, background:T.jade, borderRadius:1}}/>}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d={d}/></svg>
        <div style={{minWidth:0, flex:1}}>
          <div style={{fontSize:13, fontWeight:isOn?600:500, fontFamily:F.ui}}>{label}</div>
          {sub && <div style={{fontSize:9.5, color:T.textFaint, fontFamily:F.mono, letterSpacing:0.6, marginTop:1, textTransform:'uppercase'}}>{sub}</div>}
        </div>
      </div>
    );
  };

  return (
    <aside style={{
      width: 240, background: T.ink, borderRight: `1px solid ${T.hairline}`,
      display:'flex', flexDirection:'column', flexShrink:0,
    }}>
      {/* Brand + admin badge */}
      <div style={{padding:'20px 22px 16px', display:'flex', alignItems:'center', gap:10}}>
        <div style={{
          width:32, height:32, borderRadius:7, background:T.jade, color:T.ink,
          display:'flex', alignItems:'center', justifyContent:'center',
          fontFamily:F.display, fontSize:18, fontWeight:700,
          boxShadow:`0 0 14px ${T.jadeGlow}`,
        }}>藏</div>
        <div style={{minWidth:0}}>
          <div style={{fontFamily:F.display, fontSize:17, fontWeight:600, color:T.text, lineHeight:1}}>TruyệnAudio</div>
          <div style={{fontFamily:F.mono, fontSize:9, color:T.vermillion, letterSpacing:1.4, marginTop:3, fontWeight:600}}>ADMIN · v3.0</div>
        </div>
      </div>

      <div style={{padding:'0 16px 8px', display:'flex', flexDirection:'column', gap:2}}>
        <div style={{fontFamily:F.mono, fontSize:9, color:T.textFaint, letterSpacing:1.4, padding:'12px 14px 6px', textTransform:'uppercase'}}>Quản trị</div>
        {item('books',    'Quản lý truyện',  '24 truyện',  'M4 4h6v16H4zM14 4h6v16h-6z')}
        {item('chapters', 'Chương',           '1.847 chương', 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2')}
        {item('genres',   'Thể loại',         null,         'M7 7h.01M7 3h5a2 2 0 011.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z')}
        {item('users',    'Người dùng',       '8.4k',       'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z')}
        {item('reports',  'Báo cáo',          '3 mới',      'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z')}
      </div>

      <div style={{padding:'0 16px 8px', display:'flex', flexDirection:'column', gap:2}}>
        <div style={{fontFamily:F.mono, fontSize:9, color:T.textFaint, letterSpacing:1.4, padding:'12px 14px 6px', textTransform:'uppercase'}}>Hệ thống</div>
        {item('analytics','Thống kê',         null, 'M3 3v18h18M7 14l4-4 4 4 5-7')}
        {item('jobs',     'TTS / Hàng đợi',   '2 chạy', 'M13 10V3L4 14h7v7l9-11h-7z')}
        {item('settings', 'Cấu hình',         null, 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z')}
      </div>

      {/* Bottom: signed-in admin */}
      <div style={{marginTop:'auto', padding:16, borderTop:`1px solid ${T.hairline}`, display:'flex', alignItems:'center', gap:10}}>
        <div style={{
          width:32, height:32, borderRadius:8, background:`linear-gradient(135deg, ${T.vermillion}, ${T.gold})`,
          display:'flex', alignItems:'center', justifyContent:'center',
          fontFamily:F.display, fontSize:14, fontWeight:600, color:T.ink,
        }}>HB</div>
        <div style={{minWidth:0, flex:1}}>
          <div style={{fontFamily:F.ui, fontSize:12.5, fontWeight:600, color:T.text}}>Hào Bùi</div>
          <div style={{fontFamily:F.mono, fontSize:9, color:T.vermillion, letterSpacing:0.8, fontWeight:600}}>ROLE · ADMIN</div>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.textFaint} strokeWidth="1.8"><path d="M9 5l7 7-7 7"/></svg>
      </div>
    </aside>
  );
}

function AdminTopBar({ crumbs = [], right }) {
  return (
    <div style={{
      height:60, background:T.ink, borderBottom:`1px solid ${T.hairline}`,
      display:'flex', alignItems:'center', padding:'0 28px', gap:16, flexShrink:0,
    }}>
      <nav style={{display:'flex', alignItems:'center', gap:8, flex:1, minWidth:0}}>
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={T.textFaint} strokeWidth="2"><path d="M9 5l7 7-7 7"/></svg>}
            <span style={{
              fontFamily:F.ui, fontSize:13,
              color: i === crumbs.length-1 ? T.text : T.textMute,
              fontWeight: i === crumbs.length-1 ? 600 : 500,
              whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis',
            }}>{c}</span>
          </React.Fragment>
        ))}
      </nav>
      {right}
    </div>
  );
}

// Small input/textarea
function AField({ label, value, mono = false, hint, children }) {
  return (
    <div>
      <label style={{display:'block', fontFamily:F.mono, fontSize:9.5, letterSpacing:1.2, color:T.textMute, textTransform:'uppercase', marginBottom:7, fontWeight:600}}>
        {label}
      </label>
      {children ?? (
        <div style={{
          padding:'10px 12px', borderRadius:8,
          background:T.surface, border:`1px solid ${T.hairline}`,
          fontFamily: mono ? F.mono : F.ui, fontSize: mono ? 12.5 : 13.5,
          color:T.text, lineHeight:1.4,
        }}>{value}</div>
      )}
      {hint && <div style={{fontFamily:F.ui, fontSize:11, color:T.textFaint, marginTop:6}}>{hint}</div>}
    </div>
  );
}

function ASection({ title, action, children, danger = false }) {
  return (
    <section style={{
      background: T.surface, borderRadius:14,
      border:`1px solid ${danger ? 'oklch(0.42 0.13 25 / 0.4)' : T.hairline}`,
      overflow:'hidden',
    }}>
      <div style={{
        padding:'14px 18px', display:'flex', alignItems:'center', justifyContent:'space-between',
        borderBottom:`1px solid ${T.hairlineSoft}`,
      }}>
        <h3 style={{
          margin:0, fontFamily:F.display, fontSize:17, fontWeight:600,
          color: danger ? T.vermillion : T.text,
          letterSpacing: 0.2,
        }}>{title}</h3>
        {action}
      </div>
      <div style={{padding:18}}>{children}</div>
    </section>
  );
}

function APillBtn({ children, tone = 'default', icon }) {
  const tones = {
    default: {bg:'transparent', border:T.hairline, color:T.textDim},
    primary: {bg:T.jade, border:T.jade, color:T.ink},
    ghost:   {bg:'transparent', border:'transparent', color:T.textDim},
    jade:    {bg:T.jadeGlow, border:`oklch(0.74 0.11 165 / 0.35)`, color:T.jade},
    gold:    {bg:'oklch(0.80 0.10 85 / 0.12)', border:'oklch(0.80 0.10 85 / 0.35)', color:T.gold},
    danger:  {bg:'oklch(0.62 0.18 27 / 0.10)', border:'oklch(0.62 0.18 27 / 0.35)', color:T.vermillion},
    purple:  {bg:'oklch(0.72 0.13 295 / 0.12)', border:'oklch(0.72 0.13 295 / 0.35)', color:T.violet},
  }[tone];
  return (
    <button style={{
      display:'inline-flex', alignItems:'center', gap:8,
      padding:'8px 14px', borderRadius:8,
      background:tones.bg, border:`1px solid ${tones.border}`,
      color:tones.color, cursor:'pointer',
      fontFamily:F.ui, fontSize:12.5, fontWeight:600, letterSpacing:0.1,
    }}>
      {icon}
      {children}
    </button>
  );
}

// ──────────────────────────────────────────────────────────
// 08 · Manage Books
// ──────────────────────────────────────────────────────────
function WebAdminManageBooks() {
  const books = [
    {id:1, title:'Tiên Nghịch', author:'Nhĩ Căn',          chapters:2078, hue:165, featured:true,  label:'⭐ Weekly Star', status:'ongoing',   updated:'2h trước'},
    {id:2, title:'Phàm Nhân Tu Tiên', author:'Vong Ngữ',     chapters:2448, hue:200, featured:false, status:'completed', updated:'1 ngày trước'},
    {id:3, title:'Đấu Phá Thương Khung', author:'Thiên Tằm Thổ Đậu', chapters:1648, hue:55, featured:false, status:'completed', updated:'3 ngày trước'},
    {id:4, title:'Già Thiên', author:'Thần Đông',          chapters:1390, hue:25,  featured:false, status:'completed', updated:'1 tuần trước'},
    {id:5, title:'Thần Mộ', author:'Thần Đông',             chapters:752,  hue:295, featured:false, status:'completed', updated:'2 tuần trước'},
    {id:6, title:'Vũ Động Càn Khôn', author:'Thiên Tằm Thổ Đậu', chapters:1219, hue:235, featured:false, status:'completed', updated:'2 tuần trước'},
    {id:7, title:'Đại Chủ Tể', author:'Thiên Tằm Thổ Đậu', chapters:1554, hue:0,   featured:false, status:'completed', updated:'1 tháng trước'},
    {id:8, title:'Vô Thượng Sát Thần', author:'Vô Tội',     chapters:128,  hue:165, featured:false, status:'ongoing',   updated:'5h trước'},
  ];
  const featured = books.find(b => b.featured);

  return (
    <div style={{display:'flex', height:'100%', background:T.ink, color:T.text}}>
      <AdminSidebar active="books"/>
      <div style={{flex:1, display:'flex', flexDirection:'column', minWidth:0}}>
        <AdminTopBar
          crumbs={['Quản trị', 'Quản lý truyện']}
          right={
            <div style={{display:'flex', alignItems:'center', gap:10}}>
              <APillBtn icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 4v16m8-8H4"/></svg>} tone="primary">Truyện mới</APillBtn>
              <APillBtn icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>}>Nhập EPUB</APillBtn>
            </div>
          }
        />
        <div style={{flex:1, overflow:'hidden', padding:'24px 32px', display:'flex', flexDirection:'column', gap:18, minHeight:0}}>
          {/* Header row */}
          <div style={{display:'flex', alignItems:'flex-end', justifyContent:'space-between'}}>
            <div>
              <h1 style={{margin:0, fontFamily:F.display, fontSize:32, fontWeight:600, letterSpacing:0.3}}>Quản lý truyện</h1>
              <div style={{fontFamily:F.ui, fontSize:13, color:T.textMute, marginTop:6}}>Đặt spotlight, chỉnh sửa và sắp xếp thư viện · {books.length} truyện</div>
            </div>
            <div style={{display:'flex', gap:10}}>
              {[['Tất cả', 24], ['Đang ra', 6], ['Hoàn thành', 18], ['Nổi bật', 1]].map(([n,c],i) => (
                <div key={n} style={{
                  padding:'8px 14px', borderRadius:999,
                  background: i===0 ? T.jadeGlow : 'transparent',
                  border:`1px solid ${i===0 ? 'oklch(0.74 0.11 165 / 0.35)' : T.hairline}`,
                  color: i===0 ? T.jade : T.textDim,
                  fontFamily:F.ui, fontSize:12, fontWeight:500, cursor:'pointer',
                  display:'flex', alignItems:'center', gap:7,
                }}>
                  <span>{n}</span>
                  <span style={{fontFamily:F.mono, fontSize:10, color: i===0 ? T.jade : T.textFaint}}>{c}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Spotlight banner */}
          <div style={{
            display:'flex', alignItems:'center', gap:14,
            padding:'14px 18px', borderRadius:12,
            background:'linear-gradient(135deg, oklch(0.80 0.10 85 / 0.12), oklch(0.62 0.18 27 / 0.08))',
            border:`1px solid oklch(0.80 0.10 85 / 0.30)`,
          }}>
            <svg width="22" height="22" viewBox="0 0 20 20" fill={T.gold}><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontFamily:F.mono, fontSize:9.5, letterSpacing:1.4, color:T.gold, fontWeight:700, textTransform:'uppercase'}}>Đang spotlight · {featured.label}</div>
              <div style={{fontFamily:F.display, fontSize:18, fontWeight:600, color:T.text, marginTop:2}}>{featured.title}</div>
            </div>
            <APillBtn tone="ghost">Đổi nhãn</APillBtn>
            <APillBtn tone="default">Bỏ spotlight</APillBtn>
          </div>

          {/* Search bar */}
          <div style={{display:'flex', alignItems:'center', gap:12}}>
            <div style={{
              flex:1, display:'flex', alignItems:'center', gap:10,
              padding:'10px 14px', borderRadius:10,
              background:T.surface, border:`1px solid ${T.hairline}`,
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.textFaint} strokeWidth="2"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
              <input readOnly placeholder="Tìm theo tên, tác giả, ID…" style={{
                flex:1, background:'none', border:'none', outline:'none', color:T.text,
                fontFamily:F.ui, fontSize:13.5,
              }}/>
              <span style={{fontFamily:F.mono, fontSize:10, color:T.textFaint, padding:'2px 6px', background:T.raised, borderRadius:4, border:`1px solid ${T.hairline}`}}>⌘K</span>
            </div>
            <div style={{display:'flex', gap:8}}>
              <APillBtn icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"/></svg>}>Lọc</APillBtn>
              <APillBtn icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 4h13M3 8h9M3 12h9m5-4v12m0 0l-4-4m4 4l4-4"/></svg>}>Sắp xếp</APillBtn>
            </div>
          </div>

          {/* Table */}
          <div style={{
            flex:1, minHeight:0, overflow:'hidden',
            background:T.surface, borderRadius:14, border:`1px solid ${T.hairline}`,
            display:'flex', flexDirection:'column',
          }}>
            <div style={{
              display:'grid', gridTemplateColumns:'48px 1fr 220px 110px 130px 140px 100px',
              padding:'10px 18px', borderBottom:`1px solid ${T.hairlineSoft}`,
              fontFamily:F.mono, fontSize:9.5, letterSpacing:1.2, color:T.textMute, textTransform:'uppercase', fontWeight:600,
              alignItems:'center', gap:14,
            }}>
              <span/>
              <span>Truyện</span>
              <span>Tác giả</span>
              <span style={{textAlign:'right'}}>Chương</span>
              <span>Trạng thái</span>
              <span>Cập nhật</span>
              <span style={{textAlign:'right'}}>Hành động</span>
            </div>
            <div style={{flex:1, overflow:'auto'}}>
              {books.map((b, i) => (
                <div key={b.id} style={{
                  display:'grid', gridTemplateColumns:'48px 1fr 220px 110px 130px 140px 100px',
                  padding:'12px 18px', alignItems:'center', gap:14,
                  borderBottom: i < books.length-1 ? `1px solid ${T.hairlineSoft}` : 'none',
                  background: b.featured ? 'oklch(0.80 0.10 85 / 0.04)' : 'transparent',
                }}>
                  <Cover w={36} h={48} hue={b.hue} seed={b.id} radius={4} label={null}/>
                  <div style={{display:'flex', flexDirection:'column', gap:4, minWidth:0}}>
                    <div style={{display:'flex', alignItems:'center', gap:8}}>
                      <span style={{fontFamily:F.display, fontSize:15.5, fontWeight:600, color:T.text, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{b.title}</span>
                      {b.featured && (
                        <span style={{
                          display:'inline-flex', alignItems:'center', gap:4,
                          padding:'2px 7px', borderRadius:999,
                          background:'oklch(0.80 0.10 85 / 0.18)', border:`1px solid oklch(0.80 0.10 85 / 0.4)`,
                          fontFamily:F.mono, fontSize:9, color:T.gold, fontWeight:700, letterSpacing:0.6,
                        }}>★ {b.label.replace(/^[^\s]+\s/, '')}</span>
                      )}
                    </div>
                    <div style={{fontFamily:F.mono, fontSize:10, color:T.textFaint, letterSpacing:0.5}}>ID #{String(b.id).padStart(4,'0')}</div>
                  </div>
                  <span style={{fontFamily:F.ui, fontSize:13, color:T.textDim}}>{b.author}</span>
                  <span style={{fontFamily:F.mono, fontSize:13, color:T.text, textAlign:'right', fontWeight:500}}>{b.chapters.toLocaleString()}</span>
                  <span>
                    <span style={{
                      display:'inline-flex', alignItems:'center', gap:6,
                      padding:'4px 10px', borderRadius:999,
                      background: b.status === 'ongoing' ? T.jadeGlow : 'oklch(0.72 0.04 260 / 0.12)',
                      color: b.status === 'ongoing' ? T.jade : T.slate,
                      fontFamily:F.ui, fontSize:11, fontWeight:600,
                    }}>
                      <span style={{width:6, height:6, borderRadius:'50%', background:'currentColor'}}/>
                      {b.status === 'ongoing' ? 'Đang ra' : 'Hoàn thành'}
                    </span>
                  </span>
                  <span style={{fontFamily:F.mono, fontSize:11, color:T.textMute}}>{b.updated}</span>
                  <div style={{display:'flex', justifyContent:'flex-end', gap:6}}>
                    <button style={{padding:7, borderRadius:7, background:'transparent', border:`1px solid ${T.hairline}`, color: b.featured ? T.gold : T.textMute, cursor:'pointer', display:'flex'}}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill={b.featured ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8"><path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>
                    </button>
                    <button style={{padding:'7px 12px', borderRadius:7, background:T.jadeGlow, border:`1px solid oklch(0.74 0.11 165 / 0.35)`, color:T.jade, cursor:'pointer', fontFamily:F.ui, fontSize:11.5, fontWeight:600, display:'inline-flex', alignItems:'center', gap:5}}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                      Sửa
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// 09 · Edit Book
// ──────────────────────────────────────────────────────────
function WebAdminEditBook() {
  const genres = [
    {n:'Tiên hiệp', on:true}, {n:'Huyền huyễn', on:true}, {n:'Trường thiên', on:true},
    {n:'Hệ thống', on:false}, {n:'Đô thị', on:false}, {n:'Khoa huyễn', on:false}, {n:'Trinh thám', on:false},
  ];
  const recentChapters = [
    {n:2078, t:'Đại đạo · Vô tận chi cảnh', dur:'24:18', status:'ready'},
    {n:2077, t:'Một bước đăng thiên', dur:'19:42', status:'ready'},
    {n:2076, t:'Vô thượng đại đạo, ta tự đi', dur:'22:05', status:'pending'},
    {n:2075, t:'Phương Đông Bạch quay về', dur:'21:33', status:'ready'},
    {n:2074, t:'Sát kiếp giáng lâm', dur:'18:50', status:'ready'},
  ];

  return (
    <div style={{display:'flex', height:'100%', background:T.ink, color:T.text}}>
      <AdminSidebar active="books"/>
      <div style={{flex:1, display:'flex', flexDirection:'column', minWidth:0}}>
        <AdminTopBar
          crumbs={['Quản trị', 'Quản lý truyện', 'Tiên Nghịch', 'Chỉnh sửa']}
          right={
            <div style={{display:'flex', alignItems:'center', gap:10}}>
              <APillBtn icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>}>Xem trên app</APillBtn>
              <APillBtn tone="primary" icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 13l4 4L19 7"/></svg>}>Lưu thay đổi</APillBtn>
            </div>
          }
        />
        <div style={{flex:1, overflow:'auto', padding:'24px 32px', display:'flex', flexDirection:'column', gap:18}}>
          <h1 style={{margin:0, fontFamily:F.display, fontSize:30, fontWeight:600, letterSpacing:0.3}}>Chỉnh sửa truyện</h1>

          {/* Two-column layout: info + sidebar with chapters */}
          <div style={{display:'grid', gridTemplateColumns:'1fr 380px', gap:18, alignItems:'start'}}>
            <div style={{display:'flex', flexDirection:'column', gap:18}}>
              {/* Basic info */}
              <ASection title="Thông tin cơ bản">
                <div style={{display:'flex', gap:20}}>
                  {/* Cover */}
                  <div style={{flexShrink:0, display:'flex', flexDirection:'column', gap:10, alignItems:'center'}}>
                    <Cover w={140} h={200} hue={165} seed={2} radius={10} label={null}/>
                    <button style={{
                      padding:'7px 12px', borderRadius:8, fontSize:11.5, fontFamily:F.ui, fontWeight:600,
                      background:'transparent', border:`1px solid ${T.hairline}`, color:T.textDim, cursor:'pointer',
                      display:'inline-flex', alignItems:'center', gap:6,
                    }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
                      Đổi ảnh bìa
                    </button>
                    <div style={{fontFamily:F.mono, fontSize:9, color:T.textFaint, textAlign:'center', letterSpacing:0.5}}>JPG · 800×1200<br/>2.4 MB</div>
                  </div>

                  {/* Fields */}
                  <div style={{flex:1, display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, alignSelf:'flex-start'}}>
                    <div style={{gridColumn:'1 / -1'}}>
                      <AField label="Tên truyện">
                        <div style={{padding:'10px 12px', borderRadius:8, background:T.surface, border:`1px solid ${T.jade}`, fontFamily:F.display, fontSize:18, color:T.text}}>
                          Tiên Nghịch
                        </div>
                      </AField>
                    </div>
                    <AField label="Tác giả" value="Nhĩ Căn"/>
                    <AField label="Dịch giả" value="Cộng đồng dịch giả"/>
                    <AField label="Tình trạng">
                      <div style={{display:'flex', gap:6}}>
                        {[['Đang ra',true],['Hoàn thành',false],['Tạm dừng',false]].map(([n,on]) => (
                          <span key={n} style={{
                            padding:'8px 12px', borderRadius:8, fontFamily:F.ui, fontSize:12, fontWeight:500,
                            background: on ? T.jadeGlow : 'transparent',
                            border:`1px solid ${on ? 'oklch(0.74 0.11 165 / 0.4)' : T.hairline}`,
                            color: on ? T.jade : T.textMute, cursor:'pointer',
                          }}>{n}</span>
                        ))}
                      </div>
                    </AField>
                    <AField label="ID truyện" value="#0001" mono/>
                    <div style={{gridColumn:'1 / -1'}}>
                      <AField label="Mô tả / Giới thiệu">
                        <div style={{
                          padding:'12px 14px', borderRadius:8, minHeight:90,
                          background:T.surface, border:`1px solid ${T.hairline}`,
                          fontFamily:F.ui, fontSize:13, color:T.textDim, lineHeight:1.55,
                        }}>
                          Vương Lâm — một thiếu niên bình thường ở Hà Phố Trấn, vì một cơ duyên mà bước vào con đường tu tiên. Trên con đường gian khổ ấy, hắn nghịch thiên cải mệnh, tự mình nắm lấy đại đạo, từ một phàm nhân yếu đuối trở thành tồn tại nghịch thiên kinh động cả tam thiên đại đạo…
                          <span style={{borderRight:`1px solid ${T.jade}`, marginLeft:1, animation:'blink 1s infinite'}}/>
                        </div>
                      </AField>
                    </div>
                  </div>
                </div>
              </ASection>

              {/* Genres */}
              <ASection title="Thể loại" action={<span style={{fontFamily:F.mono, fontSize:10, color:T.textFaint, letterSpacing:0.6}}>{genres.filter(g=>g.on).length} ĐÃ CHỌN</span>}>
                <div style={{display:'flex', flexWrap:'wrap', gap:8}}>
                  {genres.map(g => (
                    <span key={g.n} style={{
                      padding:'8px 14px', borderRadius:999, fontFamily:F.ui, fontSize:12.5, fontWeight:500,
                      background: g.on ? T.jadeGlow : 'transparent',
                      border:`1px solid ${g.on ? 'oklch(0.74 0.11 165 / 0.4)' : T.hairline}`,
                      color: g.on ? T.jade : T.textMute, cursor:'pointer',
                      display:'inline-flex', alignItems:'center', gap:6,
                    }}>
                      {g.on && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M5 13l4 4L19 7"/></svg>}
                      {g.n}
                    </span>
                  ))}
                  <span style={{
                    padding:'8px 14px', borderRadius:999, fontFamily:F.ui, fontSize:12.5,
                    border:`1px dashed ${T.hairline}`, color:T.textFaint, cursor:'pointer',
                  }}>+ Thêm thể loại</span>
                </div>
              </ASection>

              {/* Auto-split tool */}
              <ASection title="Tự động tách chương" action={<span style={{fontFamily:F.mono, fontSize:9.5, color:T.gold, letterSpacing:0.8, fontWeight:600}}>⚠ NGUY HIỂM</span>}>
                <p style={{margin:'0 0 14px', fontFamily:F.ui, fontSize:12.5, color:T.textMute, lineHeight:1.55}}>
                  Gộp toàn bộ nội dung lại rồi tách theo tiêu đề <code style={{padding:'1px 6px', background:T.raised, borderRadius:4, fontFamily:F.mono, fontSize:11.5, color:T.jade}}>Chương N</code> / <code style={{padding:'1px 6px', background:T.raised, borderRadius:4, fontFamily:F.mono, fontSize:11.5, color:T.jade}}>Chapter N</code>. Audio cũ sẽ bị xoá, mọi chương mới về trạng thái <span style={{color:T.gold, fontWeight:600}}>pending</span>.
                </p>
                <div style={{display:'flex', alignItems:'center', gap:14, padding:'12px 14px', background:T.raised, borderRadius:10, border:`1px solid ${T.hairline}`}}>
                  <APillBtn tone="jade" icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 3l14 9-14 9V3z"/></svg>}>Chạy tách tự động</APillBtn>
                  <div style={{flex:1}}>
                    <div style={{fontFamily:F.mono, fontSize:11, color:T.jade, fontWeight:600}}>✓ Lần chạy gần nhất: 2.061 → 2.078 chương</div>
                    <div style={{fontFamily:F.ui, fontSize:11.5, color:T.textFaint, marginTop:2}}>3 chương thiếu nội dung · 2 ngày trước</div>
                  </div>
                </div>
              </ASection>

              {/* Strip string */}
              <ASection title="Xoá chuỗi khỏi tất cả chương">
                <p style={{margin:'0 0 12px', fontFamily:F.ui, fontSize:12.5, color:T.textMute, lineHeight:1.55}}>
                  Khớp chính xác và xoá khỏi <span style={{fontFamily:F.mono, color:T.text}}>text_content</span> của mọi chương. Hữu ích để loại bỏ banner quảng cáo của nguồn gốc.
                </p>
                <div style={{display:'flex', gap:10}}>
                  <div style={{
                    flex:1, padding:'10px 14px', borderRadius:8, minHeight:54,
                    background:T.surface, border:`1px solid ${T.hairline}`,
                    fontFamily:F.mono, fontSize:12, color:T.textDim, lineHeight:1.55,
                  }}>{`(Truyện được dịch bởi nhom-dich-XYZ.com — vui lòng ghé thăm để ủng hộ)`}</div>
                  <APillBtn tone="danger" icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>}>Xoá chuỗi</APillBtn>
                </div>
              </ASection>

              {/* Danger zone */}
              <ASection title="Vùng nguy hiểm" danger>
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:18}}>
                  <div>
                    <div style={{fontFamily:F.ui, fontSize:14, fontWeight:600, color:T.text}}>Xoá truyện</div>
                    <div style={{fontFamily:F.ui, fontSize:12.5, color:T.textMute, marginTop:4}}>Xoá vĩnh viễn truyện, 2.078 chương, file audio và ảnh bìa. Không thể hoàn tác.</div>
                  </div>
                  <APillBtn tone="danger" icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>}>Xoá truyện</APillBtn>
                </div>
              </ASection>
            </div>

            {/* Right column: stats + recent chapters */}
            <div style={{display:'flex', flexDirection:'column', gap:18, position:'sticky', top:0}}>
              {/* Stats */}
              <ASection title="Số liệu">
                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:14}}>
                  {[
                    ['LƯỢT NGHE', '184k', T.jade],
                    ['ĐANG NGHE', '2.4k', T.gold],
                    ['ĐÁNH GIÁ', '4.8 / 5', T.violet],
                    ['BÌNH LUẬN', '1.2k', T.blue],
                  ].map(([l,v,c]) => (
                    <div key={l} style={{padding:'12px 14px', background:T.raised, borderRadius:10, border:`1px solid ${T.hairlineSoft}`}}>
                      <div style={{fontFamily:F.mono, fontSize:9, letterSpacing:1.2, color:T.textFaint, fontWeight:600}}>{l}</div>
                      <div style={{fontFamily:F.display, fontSize:24, fontWeight:600, color:c, marginTop:4, letterSpacing:0.3}}>{v}</div>
                    </div>
                  ))}
                </div>
              </ASection>

              {/* Recent chapters */}
              <ASection title="Chương gần đây" action={<span style={{fontFamily:F.mono, fontSize:10, color:T.textFaint, letterSpacing:0.6}}>2.078 TỔNG</span>}>
                <div style={{display:'flex', flexDirection:'column', gap:2, marginBottom:12}}>
                  <APillBtn tone="jade" icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 4v16m8-8H4"/></svg>}>Thêm chương mới</APillBtn>
                </div>
                <div style={{display:'flex', flexDirection:'column'}}>
                  {recentChapters.map((ch,i) => (
                    <div key={ch.n} style={{
                      display:'flex', alignItems:'center', gap:10,
                      padding:'10px 12px', borderRadius:8, cursor:'pointer',
                      borderBottom: i < recentChapters.length-1 ? `1px solid ${T.hairlineSoft}` : 'none',
                    }}>
                      <span style={{fontFamily:F.mono, fontSize:11, color:T.textFaint, width:40, fontVariantNumeric:'tabular-nums'}}>#{ch.n}</span>
                      <span style={{flex:1, fontFamily:F.ui, fontSize:12.5, color:T.text, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{ch.t}</span>
                      <span style={{
                        width:8, height:8, borderRadius:'50%',
                        background: ch.status === 'ready' ? T.jade : T.gold,
                        flexShrink:0,
                      }} title={ch.status}/>
                      <span style={{fontFamily:F.mono, fontSize:10.5, color:T.textMute, width:42, textAlign:'right'}}>{ch.dur}</span>
                    </div>
                  ))}
                </div>
                <button style={{
                  marginTop:8, width:'100%', padding:'8px',
                  background:'transparent', border:`1px dashed ${T.hairline}`, borderRadius:8,
                  color:T.textMute, fontFamily:F.ui, fontSize:11.5, cursor:'pointer',
                }}>Xem tất cả 2.078 chương →</button>
              </ASection>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// 10 · Edit Chapter (with split modal)
// ──────────────────────────────────────────────────────────
function WebAdminEditChapter({ showSplit = false }) {
  const sidebarChapters = [
    {n:2078, t:'Đại đạo · Vô tận chi cảnh', active:true},
    {n:2077, t:'Một bước đăng thiên'},
    {n:2076, t:'Vô thượng đại đạo, ta tự đi'},
    {n:2075, t:'Phương Đông Bạch quay về'},
    {n:2074, t:'Sát kiếp giáng lâm'},
    {n:2073, t:'Chân thân hợp nhất'},
    {n:2072, t:'Nhất kiếm khai thiên'},
    {n:2071, t:'Vương Lâm, ngươi lại đến'},
    {n:2070, t:'Tam thiên đại đạo, ta vi đầu'},
    {n:2069, t:'Vạn linh đỉnh phong'},
    {n:2068, t:'Nghịch thiên cải mệnh'},
    {n:2067, t:'Ám ảnh ngàn năm'},
    {n:2066, t:'Phá kén thành điệp'},
    {n:2065, t:'Đoạn tiên đài thượng'},
  ];

  const splitParts = [
    {n:1, title:'Chương 2078: Đại đạo · Vô tận chi cảnh', words:1842, preview:'Vương Lâm đứng trên đỉnh Vạn Linh Đài, ánh mắt phẳng lặng quét qua tam thiên đại đạo. Mỗi một đạo, mỗi một…'},
    {n:2, title:'Chương 2079: Vô thượng chi cảnh', words:2104, preview:'Khi đại đạo bị nắm trong tay, thiên hạ vạn vật đều phải khom mình. Vương Lâm nhẹ nhàng vung tay, không gian liền…'},
    {n:3, title:'Chương 2080: Bước cuối cùng', words:1936, preview:'Một bước, hai bước, ba bước. Bước thứ ba kia, chính là bước thiên đạo không thể với tới. Vương Lâm đứng đó…'},
  ];

  return (
    <div style={{display:'flex', height:'100%', background:T.ink, color:T.text, position:'relative'}}>
      <AdminSidebar active="books"/>

      {/* Chapter list rail */}
      <aside style={{
        width: 280, background: T.surface, borderRight:`1px solid ${T.hairline}`,
        display:'flex', flexDirection:'column', flexShrink:0,
      }}>
        <div style={{padding:'16px 18px', borderBottom:`1px solid ${T.hairline}`}}>
          <div style={{display:'flex', alignItems:'center', gap:6, marginBottom:10, color:T.textMute, cursor:'pointer'}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 19l-7-7 7-7"/></svg>
            <span style={{fontFamily:F.ui, fontSize:11.5}}>Tiên Nghịch</span>
          </div>
          <div style={{
            display:'flex', alignItems:'center', gap:8,
            padding:'8px 10px', borderRadius:8,
            background:T.raised, border:`1px solid ${T.hairline}`,
          }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={T.textFaint} strokeWidth="2"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
            <input readOnly placeholder="Tìm chương…" style={{flex:1, background:'none', border:'none', outline:'none', color:T.text, fontFamily:F.ui, fontSize:11.5}}/>
          </div>
          <button style={{
            marginTop:10, width:'100%',
            display:'flex', alignItems:'center', justifyContent:'center', gap:6,
            padding:'8px', borderRadius:8,
            background:T.jadeGlow, border:`1px solid oklch(0.74 0.11 165 / 0.35)`,
            color:T.jade, fontFamily:F.ui, fontSize:11.5, fontWeight:600, cursor:'pointer',
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 4v16m8-8H4"/></svg>
            Thêm chương mới
          </button>
        </div>
        <div style={{flex:1, overflow:'auto', padding:'8px 0'}}>
          {sidebarChapters.map(ch => (
            <div key={ch.n} style={{
              display:'flex', alignItems:'center', gap:10,
              padding:'9px 18px', cursor:'pointer',
              background: ch.active ? T.jadeGlow : 'transparent',
              borderLeft: ch.active ? `2px solid ${T.jade}` : '2px solid transparent',
              color: ch.active ? T.text : T.textDim,
            }}>
              <span style={{
                fontFamily:F.mono, fontSize:10.5, width:42, textAlign:'right',
                color: ch.active ? T.jade : T.textFaint, fontWeight:ch.active?600:500,
              }}>#{ch.n}</span>
              <span style={{
                flex:1, fontFamily:F.ui, fontSize:12, fontWeight: ch.active ? 600 : 500,
                whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis',
              }}>{ch.t}</span>
            </div>
          ))}
        </div>
        <div style={{padding:'10px 14px', borderTop:`1px solid ${T.hairline}`, display:'flex', alignItems:'center', justifyContent:'space-between'}}>
          <button style={{padding:6, background:'transparent', border:'none', color:T.textFaint, cursor:'pointer'}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 19l-7-7 7-7"/></svg>
          </button>
          <span style={{fontFamily:F.mono, fontSize:10, color:T.textMute, letterSpacing:0.5}}>1 / 42 · 2.078 chương</span>
          <button style={{padding:6, background:'transparent', border:'none', color:T.text, cursor:'pointer'}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 5l7 7-7 7"/></svg>
          </button>
        </div>
      </aside>

      {/* Editor main */}
      <div style={{flex:1, display:'flex', flexDirection:'column', minWidth:0}}>
        <AdminTopBar
          crumbs={['Quản trị', 'Tiên Nghịch', 'Chương 2078']}
          right={
            <div style={{display:'flex', alignItems:'center', gap:8}}>
              <APillBtn tone="purple" icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>}>Sửa AI</APillBtn>
              <APillBtn tone="gold" icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121"/></svg>}>Tách chương</APillBtn>
              <APillBtn tone="danger" icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7"/></svg>}>Xoá</APillBtn>
              <APillBtn tone="primary" icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 13l4 4L19 7"/></svg>}>Lưu thay đổi</APillBtn>
            </div>
          }
        />
        <div style={{flex:1, overflow:'hidden', padding:'24px 32px', display:'flex', flexDirection:'column', gap:18, minHeight:0}}>
          {/* Title row */}
          <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:18}}>
            <div>
              <h1 style={{margin:0, fontFamily:F.display, fontSize:28, fontWeight:600, letterSpacing:0.3}}>Chỉnh sửa chương</h1>
              <div style={{fontFamily:F.mono, fontSize:11, color:T.textFaint, letterSpacing:0.6, marginTop:4}}>ID #ch_2078_a4f · Cập nhật 14 phút trước · ĐÃ LƯU</div>
            </div>
            <div style={{display:'flex', gap:8}}>
              <button style={{padding:'7px 12px', borderRadius:7, background:'transparent', border:`1px solid ${T.hairline}`, color:T.textMute, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:6, fontFamily:F.ui, fontSize:11.5}}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 19l-7-7 7-7"/></svg> Trước
              </button>
              <button style={{padding:'7px 12px', borderRadius:7, background:T.jadeGlow, border:`1px solid oklch(0.74 0.11 165 / 0.35)`, color:T.jade, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:6, fontFamily:F.ui, fontSize:11.5, fontWeight:600}}>
                Sau <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 5l7 7-7 7"/></svg>
              </button>
            </div>
          </div>

          {/* Title + index */}
          <div style={{display:'grid', gridTemplateColumns:'1fr 140px 200px', gap:14}}>
            <AField label="Tiêu đề chương">
              <div style={{padding:'10px 12px', borderRadius:8, background:T.surface, border:`1px solid ${T.jade}`, fontFamily:F.display, fontSize:18, color:T.text}}>
                Chương 2078: Đại đạo · Vô tận chi cảnh
              </div>
            </AField>
            <AField label="Số chương" value="2078" mono/>
            <AField label="Trạng thái">
              <div style={{display:'flex', gap:6}}>
                {[['Pending',false,T.gold],['Ready',true,T.jade],['Hidden',false,T.slate]].map(([n,on,c]) => (
                  <span key={n} style={{
                    flex:1, padding:'8px 10px', borderRadius:8, fontFamily:F.ui, fontSize:11.5, fontWeight:500,
                    textAlign:'center',
                    background: on ? `oklch(0.74 0.11 165 / 0.18)` : 'transparent',
                    border:`1px solid ${on ? c : T.hairline}`,
                    color: on ? c : T.textMute, cursor:'pointer',
                  }}>{n}</span>
                ))}
              </div>
            </AField>
          </div>

          {/* Content textarea — fills */}
          <div style={{flex:1, minHeight:0, display:'flex', flexDirection:'column', gap:8}}>
            <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
              <label style={{fontFamily:F.mono, fontSize:9.5, letterSpacing:1.2, color:T.textMute, textTransform:'uppercase', fontWeight:600}}>Nội dung</label>
              <div style={{display:'flex', alignItems:'center', gap:14, fontFamily:F.mono, fontSize:11, color:T.textFaint}}>
                <span><span style={{color:T.text, fontWeight:600}}>1.842</span> từ</span>
                <span><span style={{color:T.text, fontWeight:600}}>10.487</span> ký tự</span>
                <span>~ <span style={{color:T.jade, fontWeight:600}}>24:18</span> đọc</span>
              </div>
            </div>
            <div style={{
              flex:1, minHeight:0, position:'relative',
              background:T.surface, border:`1px solid ${T.hairline}`, borderRadius:12,
              overflow:'hidden',
            }}>
              <div style={{
                height:'100%', overflow:'auto', padding:'18px 22px',
                fontFamily:'"Crimson Pro", Georgia, serif', fontSize:15, color:T.textDim, lineHeight:1.75,
              }}>
                <p style={{margin:'0 0 14px', fontFamily:F.display, fontSize:20, fontWeight:600, color:T.text}}>Chương 2078: Đại đạo · Vô tận chi cảnh</p>
                <p style={{margin:'0 0 14px'}}>Vương Lâm đứng trên đỉnh Vạn Linh Đài, ánh mắt phẳng lặng quét qua tam thiên đại đạo. Mỗi một đạo, mỗi một quy tắc, đều như nằm trong lòng bàn tay hắn, không còn chút bí ẩn nào nữa.</p>
                <p style={{margin:'0 0 14px'}}>"Đại đạo, vô tận chi cảnh…" — hắn khẽ nói, giọng nói dường như xuyên qua thiên địa, vọng vào tai mọi sinh linh trong tam thiên thế giới.</p>
                <p style={{margin:'0 0 14px'}}>Khi đại đạo bị nắm trong tay, thiên hạ vạn vật đều phải khom mình. Vương Lâm nhẹ nhàng vung tay, không gian liền nứt vỡ, hiện ra một con đường dẫn tới nơi cao hơn — nơi mà ngay cả Hồng Mông cũng không thể với tới.</p>
                <p style={{margin:'0 0 14px'}}>Một bước, hai bước, ba bước. Bước thứ ba kia, chính là bước thiên đạo không thể với tới…</p>
                <p style={{margin:'0', color:T.textFaint, fontStyle:'italic', fontSize:13.5}}>···đang viết thêm···</p>
              </div>
              {/* Status footer */}
              <div style={{
                position:'absolute', left:0, right:0, bottom:0,
                padding:'8px 18px', background:T.raised, borderTop:`1px solid ${T.hairlineSoft}`,
                display:'flex', alignItems:'center', justifyContent:'space-between',
                fontFamily:F.mono, fontSize:10.5, color:T.textMute,
              }}>
                <div style={{display:'flex', alignItems:'center', gap:14}}>
                  <span style={{display:'inline-flex', alignItems:'center', gap:6, color:T.jade}}>
                    <span style={{width:6, height:6, borderRadius:'50%', background:T.jade, boxShadow:`0 0 8px ${T.jade}`}}/>
                    AUTOSAVE · 14s
                  </span>
                  <span>UTF-8 · LF · MARKDOWN</span>
                </div>
                <span style={{color:T.gold}}>1 chuỗi quảng cáo phát hiện · <span style={{textDecoration:'underline', cursor:'pointer'}}>xem</span></span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Split chapter modal overlay */}
      {showSplit && (
        <div style={{
          position:'absolute', inset:0, background:'rgba(0,0,0,0.65)', backdropFilter:'blur(2px)',
          display:'flex', alignItems:'center', justifyContent:'center', zIndex:50, padding:32,
        }}>
          <div style={{
            width:680, maxHeight:'92%', display:'flex', flexDirection:'column',
            background:T.surface, borderRadius:16, border:`1px solid ${T.hairline}`,
            boxShadow:'0 30px 80px rgba(0,0,0,0.6)', overflow:'hidden',
          }}>
            <div style={{padding:'18px 22px', borderBottom:`1px solid ${T.hairline}`, display:'flex', alignItems:'center', justifyContent:'space-between'}}>
              <div>
                <h2 style={{margin:0, fontFamily:F.display, fontSize:22, fontWeight:600, letterSpacing:0.2}}>Tách chương</h2>
                <div style={{fontFamily:F.ui, fontSize:12.5, color:T.textMute, marginTop:4}}>Phát hiện <span style={{color:T.jade, fontWeight:600}}>{splitParts.length} phần</span> — chỉnh tiêu đề rồi xác nhận</div>
              </div>
              <button style={{padding:8, borderRadius:8, background:'transparent', border:`1px solid ${T.hairline}`, color:T.textMute, cursor:'pointer'}}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
            <div style={{padding:'14px 22px', borderBottom:`1px solid ${T.hairlineSoft}`, display:'flex', alignItems:'center', gap:10}}>
              <span style={{fontFamily:F.mono, fontSize:10.5, color:T.textMute, letterSpacing:0.6, textTransform:'uppercase', fontWeight:600}}>Tách theo:</span>
              <div style={{flex:1, padding:'7px 10px', borderRadius:7, background:T.raised, border:`1px solid ${T.hairline}`, fontFamily:F.mono, fontSize:11.5, color:T.textDim}}>
                Auto-detect (Chương N / Chapter N)
              </div>
              <APillBtn tone="default">Phân tích lại</APillBtn>
            </div>
            <div style={{flex:1, overflow:'auto', padding:'14px 22px', display:'flex', flexDirection:'column', gap:10}}>
              {splitParts.map(p => (
                <div key={p.n} style={{
                  padding:14, borderRadius:10, border:`1px solid ${T.hairline}`, background:T.raised,
                  display:'flex', flexDirection:'column', gap:8,
                }}>
                  <div style={{display:'flex', alignItems:'center', gap:10}}>
                    <span style={{fontFamily:F.mono, fontSize:11, color:T.jade, fontWeight:600, width:28}}>#{p.n}</span>
                    <div style={{flex:1, padding:'7px 10px', borderRadius:6, background:T.surface, border:`1px solid ${T.hairline}`, fontFamily:F.display, fontSize:14, fontWeight:600, color:T.text}}>{p.title}</div>
                    <span style={{fontFamily:F.mono, fontSize:10.5, color:T.textFaint}}>{p.words.toLocaleString()} từ</span>
                  </div>
                  <p style={{margin:0, fontFamily:F.mono, fontSize:11, color:T.textMute, lineHeight:1.55}}>{p.preview}</p>
                </div>
              ))}
            </div>
            <div style={{padding:'14px 22px', borderTop:`1px solid ${T.hairline}`, display:'flex', alignItems:'center', justifyContent:'flex-end', gap:10}}>
              <APillBtn tone="ghost">Huỷ</APillBtn>
              <APillBtn tone="primary">Tách thành {splitParts.length} chương</APillBtn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { WebAdminManageBooks, WebAdminEditBook, WebAdminEditChapter });
