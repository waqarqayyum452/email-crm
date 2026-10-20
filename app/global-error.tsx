'use client';

export default function GlobalError({ reset }: { error: unknown; reset: () => void; retry: () => void }) {
  return (
    <html lang="en">
      <head>
        <title>Workspace temporarily unavailable</title>
        <meta name="robots" content="noindex, nofollow" />
      </head>
      <body style={{ margin: 0, background: '#f7f8fa', color: '#263342', fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
        <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px', boxSizing: 'border-box' }}>
          <section style={{ width: '100%', maxWidth: '480px', background: '#ffffff', border: '1px solid #e2e8e6', borderRadius: '12px', padding: '32px' }}>
            <p style={{ margin: '0 0 12px', color: '#526f5f', fontSize: '13px' }}>San Diego Website Experts</p>
            <h1 style={{ margin: '0 0 16px', fontSize: '26px', lineHeight: 1.3 }}>Your workspace needs another try.</h1>
            <p style={{ margin: '0 0 24px', color: '#63717e', fontSize: '15px', lineHeight: 1.7 }}>A temporary issue prevented this page from loading. Try again or return to the overview.</p>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '20px' }}>
              <button type="button" onClick={reset} style={{ minHeight: '44px', padding: '11px 18px', border: '1px solid #24796f', borderRadius: '7px', background: '#24796f', color: '#ffffff', font: 'inherit', cursor: 'pointer' }}>Try again</button>
              <a href="/overview" style={{ color: '#24796f', fontSize: '15px', textDecoration: 'underline', textUnderlineOffset: '3px' }}>Open overview</a>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
