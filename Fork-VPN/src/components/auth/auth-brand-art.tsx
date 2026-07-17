import { Box } from '@mui/material'

/**
 * Pure CSS/SVG brand art for login left rail.
 * No bitmap poster — feels native to the product.
 */
export function AuthBrandArt() {
  return (
    <Box
      aria-hidden
      sx={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        '@keyframes forkOrbA': {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '50%': { transform: 'translate(12px, -18px) scale(1.06)' },
        },
        '@keyframes forkOrbB': {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '50%': { transform: 'translate(-16px, 10px) scale(1.08)' },
        },
        '@keyframes forkPulse': {
          '0%, 100%': { opacity: 0.35 },
          '50%': { opacity: 0.7 },
        },
        '@keyframes forkSpin': {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
        '@keyframes forkFloat': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' },
        },
      }}
    >
      {/* Base depth */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(120% 80% at 20% 10%, rgba(20,184,166,0.16) 0%, transparent 55%), radial-gradient(90% 70% at 90% 90%, rgba(99,102,241,0.1) 0%, transparent 50%), linear-gradient(165deg, #080a0e 0%, #0c0f14 45%, #0a1618 100%)',
        }}
      />

      {/* Soft orbs */}
      <Box
        sx={{
          position: 'absolute',
          width: 340,
          height: 340,
          borderRadius: '50%',
          top: -80,
          left: -60,
          background:
            'radial-gradient(circle, rgba(45,212,191,0.28) 0%, rgba(13,148,136,0.08) 40%, transparent 70%)',
          filter: 'blur(8px)',
          animation: 'forkOrbA 14s ease-in-out infinite',
        }}
      />
      <Box
        sx={{
          position: 'absolute',
          width: 280,
          height: 280,
          borderRadius: '50%',
          bottom: -40,
          right: -50,
          background:
            'radial-gradient(circle, rgba(99,102,241,0.18) 0%, transparent 68%)',
          filter: 'blur(10px)',
          animation: 'forkOrbB 18s ease-in-out infinite',
        }}
      />

      {/* Fine grid fade */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          opacity: 0.045,
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.9) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.9) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
          maskImage:
            'radial-gradient(ellipse 80% 70% at 40% 40%, black 10%, transparent 70%)',
        }}
      />

      {/* Network / globe SVG */}
      <Box
        sx={{
          position: 'absolute',
          right: { md: -20, lg: 10 },
          top: '42%',
          transform: 'translateY(-50%)',
          width: { md: 300, lg: 360 },
          height: { md: 300, lg: 360 },
          animation: 'forkFloat 10s ease-in-out infinite',
          opacity: 0.95,
        }}
      >
        <svg
          viewBox="0 0 400 400"
          width="100%"
          height="100%"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <radialGradient id="forkCore" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#2DD4BF" stopOpacity="0.35" />
              <stop offset="55%" stopColor="#0D9488" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#0D9488" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="forkRing" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#5EEAD4" stopOpacity="0.55" />
              <stop offset="50%" stopColor="#14B8A6" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#6366F1" stopOpacity="0.35" />
            </linearGradient>
            <filter id="forkGlow" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="2.5" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* outer soft core */}
          <circle cx="200" cy="200" r="120" fill="url(#forkCore)" />

          {/* orbit rings */}
          <g filter="url(#forkGlow)" opacity="0.9">
            <ellipse
              cx="200"
              cy="200"
              rx="130"
              ry="130"
              stroke="url(#forkRing)"
              strokeWidth="1.2"
              opacity="0.55"
            />
            <ellipse
              cx="200"
              cy="200"
              rx="130"
              ry="48"
              stroke="#2DD4BF"
              strokeWidth="1"
              opacity="0.35"
              transform="rotate(-18 200 200)"
            />
            <ellipse
              cx="200"
              cy="200"
              rx="130"
              ry="48"
              stroke="#818CF8"
              strokeWidth="1"
              opacity="0.28"
              transform="rotate(32 200 200)"
            />
            <ellipse
              cx="200"
              cy="200"
              rx="98"
              ry="98"
              stroke="#14B8A6"
              strokeWidth="1"
              opacity="0.25"
              strokeDasharray="4 8"
            />
          </g>

          {/* network nodes + links */}
          <g stroke="#2DD4BF" strokeOpacity="0.28" strokeWidth="1">
            <line x1="120" y1="150" x2="200" y2="110" />
            <line x1="200" y1="110" x2="280" y2="145" />
            <line x1="280" y1="145" x2="300" y2="220" />
            <line x1="300" y1="220" x2="250" y2="290" />
            <line x1="250" y1="290" x2="160" y2="285" />
            <line x1="160" y1="285" x2="110" y2="220" />
            <line x1="110" y1="220" x2="120" y2="150" />
            <line x1="200" y1="110" x2="200" y2="200" />
            <line x1="200" y1="200" x2="280" y2="145" />
            <line x1="200" y1="200" x2="250" y2="290" />
            <line x1="200" y1="200" x2="110" y2="220" />
          </g>

          {/* nodes */}
          {[
            [200, 110],
            [280, 145],
            [300, 220],
            [250, 290],
            [160, 285],
            [110, 220],
            [120, 150],
            [200, 200],
          ].map(([x, y], i) => (
            <g key={i}>
              <circle
                cx={x}
                cy={y}
                r={i === 7 ? 5.5 : 3.2}
                fill={i === 7 ? '#5EEAD4' : '#2DD4BF'}
                opacity={i === 7 ? 0.95 : 0.75}
                filter="url(#forkGlow)"
              />
              {i === 7 && (
                <circle
                  cx={x}
                  cy={y}
                  r="14"
                  stroke="#2DD4BF"
                  strokeOpacity="0.35"
                  strokeWidth="1"
                  style={{ animation: 'forkPulse 3.2s ease-in-out infinite' }}
                />
              )}
            </g>
          ))}

          {/* tiny satellites */}
          <g style={{ transformOrigin: '200px 200px', animation: 'forkSpin 48s linear infinite' }}>
            <circle cx="330" cy="200" r="2.5" fill="#A5B4FC" opacity="0.8" />
            <circle cx="70" cy="200" r="2" fill="#5EEAD4" opacity="0.55" />
          </g>
        </svg>
      </Box>

      {/* bottom vignette for text readability */}
      <Box
        sx={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: '42%',
          background:
            'linear-gradient(180deg, transparent 0%, rgba(8,10,14,0.55) 45%, rgba(8,10,14,0.88) 100%)',
        }}
      />
      <Box
        sx={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          height: '28%',
          background:
            'linear-gradient(180deg, rgba(8,10,14,0.55) 0%, transparent 100%)',
        }}
      />
    </Box>
  )
}
