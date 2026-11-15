/** ponytail: hand-rolled 24px stroke icons — swap for lucide-react if the set grows past ~20. */
const PATHS = {
  passport: "M5 3h11a3 3 0 0 1 3 3v15H5zM9 14a3 3 0 1 0 6 0 3 3 0 0 0-6 0M8 7h8",
  people: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M3 20a6 6 0 0 1 12 0M16 11a3 3 0 1 0 0-6M17 14a5 5 0 0 1 4 6",
  clipboard: "M8 4h8v3H8zM6 5H5v16h14V5h-1M9 12l2 2 4-4",
  evidence: "M4 4h6l2 3h8v13H4zM8 12h8M8 16h5",
  briefcase: "M3 8h18v12H3zM8 8V5h8v3M3 13h18",
  report: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5",
  upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
  pen: "M4 20l4-1 11-11-3-3L5 16zM14 6l3 3",
  doc: "M7 3h7l4 4v14H7zM13 3v5h5",
  seal: "M12 2l2.4 2.1 3.1-.4.9 3 2.8 1.5-1 3 1 3-2.8 1.5-.9 3-3.1-.4L12 22l-2.4-2.1-3.1.4-.9-3L2.8 15.8l1-3-1-3 2.8-1.5.9-3 3.1.4zM8.5 12l2.5 2.5 4.5-5",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2",
  alert: "M12 3l10 18H2zM12 10v4M12 17.5v.5",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  x: "M6 6l12 12M18 6L6 18",
  check: "M4 12l5 5L20 6",
  star: "M12 3l2.6 6 6.4.5-4.9 4.2 1.5 6.3L12 16.6 6.4 20l1.5-6.3L3 9.5 9.4 9z",
  signout: "M10 4H4v16h6M16 8l4 4-4 4M20 12H9",
  printer: "M6 9V3h12v6M6 17H3V9h18v8h-3M6 14h12v7H6z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "size-5" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
