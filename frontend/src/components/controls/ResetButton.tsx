import { Button } from "../ui/button";
import { memo, useCallback, useState } from "react";
import clsx from "clsx";


interface ResetButtonProps {
  onClick: () => void;
  disabled: boolean;
  showPlus?: boolean;
  title?: string;
  className?: string;
}

function _ResetButton({ onClick, disabled = false, showPlus = false, title, className }: ResetButtonProps) {
  const [spinning, setSpinning] = useState(false);
  const [pressing, setPressing] = useState(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      // Trigger quick tilt animation
      setPressing(true);
    },
    [disabled]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) {
        setPressing(false);
        return;
      }
      setPressing(false);         // remove tilt
      setSpinning(true);          // trigger full spin
      onClick();
    },
    [onClick, disabled]
  );

  return (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      title={title}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={() => setPressing(false)}
      disabled={disabled}
      className={clsx("text-zinc-500 hover:text-zinc-300", className)}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={clsx(
          "h-4 w-4",
          pressing && "animate-press-scale",
          spinning && "animate-spin-scale",
        )}
        onAnimationEnd={() => setSpinning(false)}
      >
        <g transform="translate(12, 12)">
          <g
            className={clsx(
              pressing && "animate-press-rotate",
              spinning && "animate-spin-rotate",
            )}
          >
            <g transform="translate(-12, -12)">
              <path d="M3 12a9 9 0 1 0 0.94-4" />
              <path d="M3.94 3v5h5" />
            </g>
          </g>
        </g>
        {showPlus && (
          <>
            <path d="M9 12h6" />
            <path d="M12 9v6" />
          </>
        )}
      </svg>
    </Button>
  );
}

const ResetButton = memo(_ResetButton);

export default ResetButton