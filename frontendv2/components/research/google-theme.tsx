"use client";

/**
 * Google / Material 3 theme for the research workbench.
 *
 * The rest of the app keeps its Apple-gray Tailwind look; the research project
 * surfaces opt into MUI (third-party) with Google Workspace-like colors/typography with compact radii:
 * Google Blue #1a73e8, #f8f9fa page background, white bordered cards, Roboto
 * stack, compact 4-6px radii (the oversized Material/Google pill rounding is
 * deliberately avoided). ScopedCssBaseline keeps MUI's resets
 * inside the wrapped subtree so global Tailwind styles are untouched.
 */
import type { ReactNode } from "react";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import ScopedCssBaseline from "@mui/material/ScopedCssBaseline";

export const googleResearchTheme = createTheme({
  palette: {
    mode: "light",
    primary: { main: "#1a73e8", light: "#4285f4", dark: "#1557b0", contrastText: "#ffffff" },
    secondary: { main: "#5f6368" },
    error: { main: "#d93025" },
    warning: { main: "#e8710a" },
    success: { main: "#188038" },
    info: { main: "#1967d2" },
    background: { default: "#f8f9fa", paper: "#ffffff" },
    text: { primary: "#202124", secondary: "#5f6368", disabled: "#9aa0a6" },
    divider: "#dadce0",
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily:
      'Roboto, "Google Sans", "Helvetica Neue", Arial, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    h1: { fontSize: 22, fontWeight: 500, letterSpacing: 0 },
    h2: { fontSize: 18, fontWeight: 500, letterSpacing: 0 },
    h3: { fontSize: 16, fontWeight: 500 },
    body1: { fontSize: 14 },
    body2: { fontSize: 13 },
    caption: { fontSize: 12 },
    button: { textTransform: "none", fontWeight: 500 },
  },
  components: {
    MuiPaper: { styleOverrides: { root: { backgroundImage: "none", boxShadow: "none" } } },
    MuiCard: {
      styleOverrides: {
        root: { border: "1px solid #dadce0", boxShadow: "none", borderRadius: "8px" },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { textTransform: "none", borderRadius: "8px", fontWeight: 500, paddingInline: 14 },
      },
    },
    MuiTab: {
      styleOverrides: { root: { textTransform: "none", fontWeight: 500, minHeight: 44, fontSize: 13 } },
    },
    MuiTabs: { styleOverrides: { indicator: { height: 2, borderRadius: 1 } } },
    MuiChip: {
      styleOverrides: { root: { borderRadius: "8px", fontWeight: 500 } },
    },
    MuiDialog: {
      styleOverrides: {
        paper: { borderRadius: "8px", border: "1px solid #dadce0", boxShadow: "0 6px 18px rgba(60,64,67,0.16)" },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: "8px",
          "&.Mui-selected": { backgroundColor: "#e8f0fe", color: "#174ea6" },
          "&.Mui-selected:hover": { backgroundColor: "#d2e3fc" },
        },
      },
    },
    MuiTextField: { defaultProps: { size: "small" } },
    MuiOutlinedInput: {
      styleOverrides: { root: { borderRadius: "8px", backgroundColor: "#ffffff" } },
    },
    MuiTooltip: {
      styleOverrides: { tooltip: { backgroundColor: "#3c4043", fontSize: 12, borderRadius: "8px" } },
    },
  },
});

export function GoogleResearchTheme({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider theme={googleResearchTheme}>
      <ScopedCssBaseline enableColorScheme={false}>{children}</ScopedCssBaseline>
    </ThemeProvider>
  );
}
