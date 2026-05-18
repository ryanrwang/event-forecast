/*
 * Event Forecast — Design Tokens
 *
 * Two-layer system:
 *   primitives → named by what they ARE   (color.gray.200, spacing.16)
 *   semantic   → named by what they DO    (color.text.primary, spacing.md)
 *
 * Dark-first: the product is a dark-mode data-visualization tool (see
 * 00-overview.md §7). The default theme is "dark"; a "light" override is
 * provided so accessibility / debugging users can flip it via
 * <html data-theme="light">, but no in-app toggle is part of the MVP.
 *
 * NOT tokenized (intentional):
 *   - Breakpoints — they have implicit ordering dependencies; CSS @media
 *     rules order matters more than a token would.
 *   - z-index   — a small, hand-managed stack is clearer than a token map.
 *
 * Usage:
 *   CSS:  color: var(--color-text-primary);
 *   JS:   window.TOKENS.semantic.color.text.primary
 */
(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────────
  // PRIMITIVES
  // ──────────────────────────────────────────────────────────────────

  var primitives = {
    color: {
      // Neutral ramp — tuned for a dark UI with layered surfaces.
      // 0 is the deepest backdrop, ascending values are progressively raised.
      bg: {
        0: '#07090C',   // page backdrop (deepest)
        1: '#0D1117',   // base surface
        2: '#141A22',   // raised surface (cards, rails)
        3: '#1C232E',   // higher (popovers, tooltips)
        4: '#262E3B'    // highest (modals, focused overlays)
      },
      // Text + border grays — separate ramp so dark/light remap cleanly.
      gray: {
        50:  '#F8FAFC',
        100: '#E2E8F0',
        200: '#CBD5E1',
        300: '#94A3B8',
        400: '#64748B',
        500: '#475569',
        600: '#334155',
        700: '#1E293B',
        800: '#0F172A',
        900: '#020617'
      },
      // Primary brand accent — emerald.
      emerald: {
        50:  '#ECFDF5',
        100: '#D1FAE5',
        200: '#A7F3D0',
        300: '#6EE7B7',
        400: '#34D399',
        500: '#10B981',  // brand
        600: '#059669',
        700: '#047857',
        800: '#065F46',
        900: '#064E3B'
      },
      // Verdict / status palette — used by the multi-day forecast strip,
      // the heatmap legend, and the verdict chips. These are PRIMITIVES;
      // the verdict-to-color mapping itself is a SEMANTIC token below.
      verdict: {
        quiet:    '#22C55E',  // green
        moderate: '#EAB308',  // amber
        busy:     '#F97316',  // orange
        severe:   '#EF4444'   // red
      },
      // General-purpose status (forms, toasts).
      status: {
        info:    '#38BDF8',
        success: '#22C55E',
        warning: '#EAB308',
        danger:  '#EF4444'
      },
      white: '#FFFFFF',
      black: '#000000'
    },

    // 4px base grid: 0, 1, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 56, 64, 80, 96, 128
    spacing: {
      0:   '0px',
      1:   '1px',
      2:   '2px',
      4:   '4px',
      8:   '8px',
      12:  '12px',
      16:  '16px',
      20:  '20px',
      24:  '24px',
      32:  '32px',
      40:  '40px',
      48:  '48px',
      56:  '56px',
      64:  '64px',
      80:  '80px',
      96:  '96px',
      128: '128px'
    },

    fontSize: {
      xs:  '12px',
      sm:  '14px',
      md:  '16px',
      lg:  '18px',
      xl:  '22px',
      xxl: '28px',
      display1: '40px',
      display2: '56px'
    },

    fontWeight: {
      regular:  '400',
      medium:   '500',
      semibold: '600',
      bold:     '700'
    },

    lineHeight: {
      tight:   '1.1',
      snug:    '1.25',
      normal:  '1.5',
      relaxed: '1.7'
    },

    // Font families are intentionally placeholder — overview §7 forbids
    // Inter/Roboto/Arial/system defaults. The actual display face and
    // technical/mono face are picked during the M1 design pass.
    fontFamily: {
      display: '"Display TBD", Georgia, serif',
      mono:    '"Mono TBD", "JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace',
      body:    'system-ui, sans-serif' // temporary; replaced in M1
    },

    radius: {
      none: '0px',
      xs:   '2px',
      sm:   '4px',
      md:   '8px',
      lg:   '12px',
      xl:   '16px',
      pill: '999px'
    },

    shadow: {
      none: 'none',
      sm:   '0 1px 2px rgba(0, 0, 0, 0.4)',
      md:   '0 4px 12px rgba(0, 0, 0, 0.45)',
      lg:   '0 10px 30px rgba(0, 0, 0, 0.55)',
      glow: '0 0 0 1px rgba(16, 185, 129, 0.35), 0 0 24px rgba(16, 185, 129, 0.18)'
    },

    duration: {
      instant: '0ms',
      fast:    '120ms',
      base:    '200ms',
      slow:    '360ms',
      slower:  '600ms'
    },

    easing: {
      standard:   'cubic-bezier(0.2, 0.0, 0.0, 1.0)',
      decelerate: 'cubic-bezier(0.0, 0.0, 0.2, 1.0)',
      accelerate: 'cubic-bezier(0.4, 0.0, 1.0, 1.0)',
      emphasized: 'cubic-bezier(0.2, 0.0, 0.0, 1.2)'
    },

    opacity: {
      0:   '0',
      25:  '0.25',
      50:  '0.5',
      75:  '0.75',
      90:  '0.9',
      100: '1'
    }
  };

  // ──────────────────────────────────────────────────────────────────
  // SEMANTIC — dark theme (default)
  // ──────────────────────────────────────────────────────────────────

  var semanticDark = {
    color: {
      text: {
        primary:   primitives.color.gray[50],
        secondary: primitives.color.gray[300],
        tertiary:  primitives.color.gray[400],
        muted:     primitives.color.gray[500],
        inverse:   primitives.color.gray[900],
        accent:    primitives.color.emerald[400]
      },
      bg: {
        page:    primitives.color.bg[0],
        surface: primitives.color.bg[1],
        raised:  primitives.color.bg[2],
        overlay: primitives.color.bg[3],
        modal:   primitives.color.bg[4]
      },
      border: {
        subtle: 'rgba(255, 255, 255, 0.06)',
        base:   'rgba(255, 255, 255, 0.10)',
        strong: 'rgba(255, 255, 255, 0.18)',
        accent: primitives.color.emerald[500]
      },
      interactive: {
        hover:    'rgba(255, 255, 255, 0.04)',
        active:   'rgba(255, 255, 255, 0.08)',
        selected: 'rgba(16, 185, 129, 0.12)',
        focus:    primitives.color.emerald[400]
      },
      action: {
        primary:       primitives.color.emerald[500],
        primaryHover:  primitives.color.emerald[400],
        primaryActive: primitives.color.emerald[600],
        primaryText:   primitives.color.gray[900]
      },
      link: {
        base:    primitives.color.emerald[300],
        hover:   primitives.color.emerald[200],
        visited: primitives.color.emerald[400]
      },
      status: primitives.color.status,
      // Verdict semantic — drives forecast strip chips, heatmap legend,
      // and timeline band fills. Single source of truth across M1/M2/M3.
      verdict: {
        quiet:    primitives.color.verdict.quiet,
        moderate: primitives.color.verdict.moderate,
        busy:     primitives.color.verdict.busy,
        severe:   primitives.color.verdict.severe
      }
    },
    spacing: {
      xs:  primitives.spacing[4],
      sm:  primitives.spacing[8],
      md:  primitives.spacing[16],
      lg:  primitives.spacing[24],
      xl:  primitives.spacing[32],
      xxl: primitives.spacing[48],
      xxxl: primitives.spacing[64]
    },
    typography: {
      display1: primitives.fontSize.display1,
      display2: primitives.fontSize.display2,
      heading:  primitives.fontSize.xxl,
      title:    primitives.fontSize.xl,
      body:     primitives.fontSize.md,
      caption:  primitives.fontSize.sm,
      micro:    primitives.fontSize.xs,
      font: {
        display: primitives.fontFamily.display,
        mono:    primitives.fontFamily.mono,
        body:    primitives.fontFamily.body
      },
      weight: primitives.fontWeight,
      lineHeight: primitives.lineHeight
    },
    radius: {
      xs: primitives.radius.xs,
      sm: primitives.radius.sm,
      md: primitives.radius.md,
      lg: primitives.radius.lg,
      xl: primitives.radius.xl,
      pill: primitives.radius.pill
    },
    shadow: {
      sm:   primitives.shadow.sm,
      md:   primitives.shadow.md,
      lg:   primitives.shadow.lg,
      glow: primitives.shadow.glow
    },
    transition: {
      fast: primitives.duration.fast + ' ' + primitives.easing.standard,
      base: primitives.duration.base + ' ' + primitives.easing.standard,
      slow: primitives.duration.slow + ' ' + primitives.easing.decelerate
    },
    opacity: primitives.opacity
  };

  // ──────────────────────────────────────────────────────────────────
  // SEMANTIC — light theme (override)
  // ──────────────────────────────────────────────────────────────────
  // Same shape, light surfaces. Used when <html data-theme="light">.

  var semanticLight = {
    color: {
      text: {
        primary:   primitives.color.gray[900],
        secondary: primitives.color.gray[700],
        tertiary:  primitives.color.gray[500],
        muted:     primitives.color.gray[400],
        inverse:   primitives.color.gray[50],
        accent:    primitives.color.emerald[700]
      },
      bg: {
        page:    primitives.color.gray[50],
        surface: primitives.color.white,
        raised:  primitives.color.gray[100],
        overlay: primitives.color.white,
        modal:   primitives.color.white
      },
      border: {
        subtle: 'rgba(15, 23, 42, 0.06)',
        base:   'rgba(15, 23, 42, 0.10)',
        strong: 'rgba(15, 23, 42, 0.20)',
        accent: primitives.color.emerald[600]
      },
      interactive: {
        hover:    'rgba(15, 23, 42, 0.04)',
        active:   'rgba(15, 23, 42, 0.08)',
        selected: 'rgba(16, 185, 129, 0.12)',
        focus:    primitives.color.emerald[600]
      },
      action: {
        primary:       primitives.color.emerald[600],
        primaryHover:  primitives.color.emerald[500],
        primaryActive: primitives.color.emerald[700],
        primaryText:   primitives.color.white
      },
      link: {
        base:    primitives.color.emerald[700],
        hover:   primitives.color.emerald[600],
        visited: primitives.color.emerald[800]
      },
      status: primitives.color.status,
      verdict: {
        quiet:    primitives.color.verdict.quiet,
        moderate: primitives.color.verdict.moderate,
        busy:     primitives.color.verdict.busy,
        severe:   primitives.color.verdict.severe
      }
    },
    spacing:    semanticDark.spacing,
    typography: semanticDark.typography,
    radius:     semanticDark.radius,
    shadow: {
      sm:   '0 1px 2px rgba(15, 23, 42, 0.06)',
      md:   '0 4px 12px rgba(15, 23, 42, 0.08)',
      lg:   '0 10px 30px rgba(15, 23, 42, 0.12)',
      glow: '0 0 0 1px rgba(16, 185, 129, 0.30), 0 0 24px rgba(16, 185, 129, 0.20)'
    },
    transition: semanticDark.transition,
    opacity:    semanticDark.opacity
  };

  // ──────────────────────────────────────────────────────────────────
  // CSS custom property injection
  // ──────────────────────────────────────────────────────────────────

  function flattenToCssVars(obj, prefix, out) {
    Object.keys(obj).forEach(function (key) {
      var val = obj[key];
      var name = prefix ? prefix + '-' + key : key;
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        flattenToCssVars(val, name, out);
      } else {
        out['--' + name] = String(val);
      }
    });
    return out;
  }

  function buildCssBlock(selector, semantic) {
    var vars = flattenToCssVars(semantic, '', {});
    var lines = Object.keys(vars).map(function (k) {
      return '  ' + k + ': ' + vars[k] + ';';
    });
    return selector + ' {\n' + lines.join('\n') + '\n}\n';
  }

  function injectTokens() {
    var css =
      buildCssBlock(':root', semanticDark) +
      buildCssBlock('[data-theme="light"]', semanticLight);

    var style = document.getElementById('tokens-css');
    if (!style) {
      style = document.createElement('style');
      style.id = 'tokens-css';
      document.head.appendChild(style);
    }
    style.textContent = css;
  }

  // ──────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────

  window.TOKENS = {
    primitives: primitives,
    semantic: semanticDark,   // active semantic layer (dark default)
    themes: {
      dark:  semanticDark,
      light: semanticLight
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectTokens);
  } else {
    injectTokens();
  }
})();
