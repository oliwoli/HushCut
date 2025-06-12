import { RotateCcw } from "lucide-react";
import { Button } from "../ui/button";
import { memo } from "react";


interface ResetButtonProps {
  onClick: () => void;
  disabled: boolean
}

function _ResetButton({ onClick, disabled = false }: ResetButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      className="text-zinc-500 hover:text-zinc-300"
    >
      <RotateCcw className="h-4 w-4" />
    </Button>
  );
}

const ResetButton = memo(_ResetButton);

export default ResetButton