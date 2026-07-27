import type { SVGProps } from "react";

export function LogoMark({
  size = 42,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      {...props}
    >
      <g
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M46 10H26a15 15 0 0 0 0 30h12a5 5 0 0 1 0 10H17" />
        <path d="M50 19H27a6 6 0 0 0 0 12h11a14 14 0 0 1 0 28H19" />
        <path d="M38 28H28" />
      </g>
      <g fill="currentColor">
        <circle cx="50" cy="10" r="3.2" />
        <circle cx="54" cy="19" r="3.2" />
        <circle cx="13" cy="50" r="3.2" />
        <circle cx="15" cy="59" r="3.2" />
      </g>
    </svg>
  );
}

export function Brand({
  compact = false,
  showTag = true
}: {
  compact?: boolean;
  showTag?: boolean;
}) {
  return (
    <span className="brand" aria-label="Sluice">
      <span className="orange">
        <LogoMark size={compact ? 31 : 39} />
      </span>
      {!compact && <span className="brand-word">Sluice</span>}
      {!compact && showTag && <span className="brand-tag">open source</span>}
    </span>
  );
}

export function SluiceMascot({
  size = 92,
  state = "monitoring"
}: {
  size?: number;
  state?: "monitoring" | "processing" | "success" | "alert";
}) {
  const stateColor =
    state === "success"
      ? "#16a36a"
      : state === "alert"
        ? "#d92d20"
        : state === "processing"
          ? "#ff9f1c"
          : "#ff6b00";

  return (
    <svg
      viewBox="0 0 120 142"
      width={size}
      height={(size * 142) / 120}
      fill="none"
      role="img"
      aria-label={`Personagem Sluice ${state}`}
    >
      <defs>
        <filter id={`mascot-glow-${state}`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g
        stroke="#ff6b00"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter={`url(#mascot-glow-${state})`}
      >
        <path d="M90 14H45a29 29 0 0 0 0 58h27a11 11 0 0 1 0 22H25" />
        <path d="M98 31H47a11 11 0 0 0 0 22h25a29 29 0 0 1 0 58H29" />
        <path d="M72 50H49" />
      </g>
      <g fill="#ff6b00">
        <circle cx="97" cy="14" r="6" />
        <circle cx="104" cy="31" r="6" />
        <circle cx="18" cy="94" r="6" />
        <circle cx="22" cy="111" r="6" />
      </g>
      <g fill={stateColor}>
        <rect x="45" y="40" width="5" height="12" rx="2.5" />
        <rect x="68" y="40" width="5" height="12" rx="2.5" />
      </g>
      <g
        stroke="#ff6b00"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M37 111l-4 23H21" />
        <path d="M79 111l4 23h13" />
        <path d="M18 72C7 72 5 85 5 91" />
        <path d="M102 72c11 0 13 13 13 19" />
        <circle cx="5" cy="95" r="3" fill="#ff6b00" />
        <circle cx="115" cy="95" r="3" fill="#ff6b00" />
      </g>
      {state === "processing" && (
        <g
          stroke={stateColor}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="5 5"
        >
          <circle cx="101" cy="82" r="13">
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 101 82"
              to="360 101 82"
              dur="2s"
              repeatCount="indefinite"
            />
          </circle>
        </g>
      )}
      {state === "success" && (
        <g stroke={stateColor} strokeWidth="3.5" strokeLinecap="round">
          <circle cx="101" cy="82" r="14" fill="#081711" />
          <path d="m94 82 5 5 9-11" />
        </g>
      )}
      {state === "alert" && (
        <g>
          <path d="M101 67 116 94H86Z" fill={stateColor} />
          <path d="M101 75v9" stroke="white" strokeWidth="3" strokeLinecap="round" />
          <circle cx="101" cy="89" r="1.7" fill="white" />
        </g>
      )}
    </svg>
  );
}
