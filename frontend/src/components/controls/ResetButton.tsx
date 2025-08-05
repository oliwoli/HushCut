import { RotateCcw } from "lucide-react";
import { Button } from "../ui/button";
import { memo, useCallback, useState } from "react";
import clsx from "clsx";


interface ResetButtonProps {
  onClick: () => void;
  disabled: boolean
}

function _ResetButton({ onClick, disabled = false }: ResetButtonProps) {
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
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={() => setPressing(false)}
      disabled={disabled}
      className="text-zinc-500 hover:text-zinc-300"
    >
      <RotateCcw
        className={clsx(
          "h-4 w-4 transform motion-safe:transition-transform",
          pressing && "animate-press-tilt",

          spinning && "animate-spin-ccw",
        )}
        onAnimationEnd={() => setSpinning(false)}
      />
    </Button>
  );
}

const ResetButton = memo(_ResetButton);

export default ResetButton