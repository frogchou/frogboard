import type { ReactNode } from 'react'

const icons: Record<string, ReactNode> = {
  crop: <><path d="M6 3v15h15M3 6h15v15"/></>,
  select: <path d="m5 3 13 10-6 1.3-2.6 5.8z"/>,
  rect: <rect x="4" y="5.5" width="16" height="13" rx="1.6"/>,
  ellipse: <ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>,
  arrow: <path d="m4 19 15-15m-9 0h9v9"/>,
  pen: <><path d="m4 16 11-11 4 4L8 20l-5 1zM13 7l4 4"/></>,
  text: <path d="M4 7V5h16v2M12 5v14m-4 0h8"/>,
  mosaic: <>{[4,10,16].flatMap((x,i) => [4,10,16].map((y,j) => <rect key={x + '-' + y} x={x} y={y} width="4" height="4" rx=".45" fill={(i+j)%2 ? 'none' : 'currentColor'} strokeWidth="1.3"/>))}</>,
  cover: <><rect x="3.5" y="6" width="17" height="12" rx="1.5"/><path d="M6 9h12v6H6z" fill="currentColor" stroke="none"/></>,
  undo: <path d="M8 5 3 10l5 5M3.5 10h10a6 6 0 0 1 0 12" transform="translate(0 -1.5)"/>,
  redo: <path d="m16 5 5 5-5 5m4.5-5h-10a6 6 0 0 0 0 12" transform="translate(0 -1.5)"/>,
  trash: <><path d="M3.5 6.5h17M9 6V4h6v2m-9 1 1 13h10l1-13M10 10v7m4-7v7"/></>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  save: <><path d="M12 3v12m-5-5 5 5 5-5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
  translate: <><path d="M3 6h11M8.5 3v3m3 1c-1 5-3.5 7.5-8 10m2-8c1 2.5 3.5 5 6.5 6.5M13 20l4-10 4 10m-6.5-3.5h5"/></>,
  ocr: <path d="M3.5 8V4h4m9 0h4v4m0 8v4h-4m-9 0h-4v-4M7 9h10m-10 4h7m-7 3h9"/>,
  capture: <><path d="M4 9V5a1 1 0 0 1 1-1h4m6 0h4a1 1 0 0 1 1 1v4m0 6v4a1 1 0 0 1-1 1h-4m-6 0H5a1 1 0 0 1-1-1v-4"/><circle cx="12" cy="12" r="3"/></>,
}
export function Icon({ name }: { name: string }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[name]}</svg>
}
