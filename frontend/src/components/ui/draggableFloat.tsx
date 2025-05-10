import React, { useState, useRef, useCallback } from 'react';

interface DraggableFloatProps {
    value: number;
    onChange: (value: number) => void;
    step?: number;
    shiftStep?: number;
    altStep?: number;
}

export const DraggableFloat: React.FC<DraggableFloatProps> = ({
    value,
    onChange,
    step = 1,
    shiftStep = 0.1,
    altStep = 0.01,
}) => {
    const [editing, setEditing] = useState(false);
    const startX = useRef<number>(0);
    const startVal = useRef<number>(0);
    const dragging = useRef<boolean>(false);

    const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        startX.current = e.clientX;
        startVal.current = value;
        dragging.current = false;

        const handleMouseMove = (moveEvent: MouseEvent) => {
            const deltaX = moveEvent.clientX - startX.current;
            const multiplier = moveEvent.shiftKey
                ? shiftStep
                : moveEvent.altKey
                    ? altStep
                    : step;

            const newValue = parseFloat((startVal.current + deltaX * multiplier).toFixed(5));
            dragging.current = true;
            onChange(newValue);
        };

        const handleMouseUp = (_upEvent: MouseEvent) => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);

            if (!dragging.current) {
                setEditing(true);
            }
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }, [onChange, step, shiftStep, altStep, value]);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const parsed = parseFloat(e.target.value);
        if (!isNaN(parsed)) {
            onChange(parsed);
        }
    };

    const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            setEditing(false);
        }
    };

    const handleInputBlur = () => setEditing(false);

    return (
        <div
            onMouseDown={handleMouseDown}
            style={{
                display: 'inline-block',
                padding: '4px 8px',
                border: '1px solid #ccc',
                borderRadius: 4,
                cursor: 'ew-resize',
                minWidth: 60,
                textAlign: 'center',
                userSelect: 'none',
            }}
        >
            {editing ? (
                <input
                    autoFocus
                    type="number"
                    defaultValue={value}
                    onChange={handleInputChange}
                    onKeyDown={handleInputKeyDown}
                    onBlur={handleInputBlur}
                    style={{
                        width: '100%',
                        border: 'none',
                        outline: 'none',
                        textAlign: 'center',
                    }}
                />
            ) : (
                value.toFixed(2)
            )}
        </div>
    );
};
