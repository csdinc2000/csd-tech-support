import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { initiateOutbound } from '../lib/api.js';

export function Dial() {
  const [number, setNumber] = useState('');
  const [dialing, setDialing] = useState(false);
  const navigate = useNavigate();

  const formatDisplay = (raw: string) => {
    const digits = raw.replace(/\D/g, '');
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
  };

  const handleKeypad = (d: string) => {
    setNumber(prev => {
      const digits = prev.replace(/\D/g, '');
      if (digits.length >= 10) return prev;
      return formatDisplay(digits + d);
    });
  };

  const handleBackspace = () => {
    setNumber(prev => {
      const digits = prev.replace(/\D/g, '').slice(0, -1);
      return formatDisplay(digits);
    });
  };

  const handleDial = async () => {
    const digits = number.replace(/\D/g, '');
    if (digits.length < 10) {
      toast.error('Enter a 10-digit US number');
      return;
    }
    setDialing(true);
    try {
      const result = await initiateOutbound(`+1${digits}`);
      toast.success(`Call initiated — SID: ${result.call_sid.slice(-6)}`);
      navigate(`/calls/${result.call_id}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to initiate call';
      toast.error(msg);
    } finally {
      setDialing(false);
    }
  };

  const KEYS = [
    ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
    ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
    ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
    ['*', ''], ['0', '+'], ['#', ''],
  ];

  return (
    <div className="p-6 flex justify-center">
      <div className="w-full max-w-xs">
        <h1 className="text-lg font-semibold text-white mb-6 text-center">Click-to-Call</h1>

        {/* Display */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 mb-4 text-center">
          <div className="text-2xl font-mono text-white tracking-wider min-h-[2rem]">
            {number || <span className="text-gray-600">Enter number</span>}
          </div>
        </div>

        {/* Keypad */}
        <div className="grid grid-cols-3 gap-2 mb-4">
          {KEYS.map(([digit, letters]) => (
            <button
              key={digit}
              onClick={() => handleKeypad(digit)}
              className="flex flex-col items-center justify-center bg-gray-800 hover:bg-gray-700 active:bg-gray-600 rounded-lg py-3 transition-colors"
            >
              <span className="text-lg font-medium text-white leading-none">{digit}</span>
              {letters && <span className="text-[9px] text-gray-500 mt-0.5 tracking-widest">{letters}</span>}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleBackspace}
            disabled={!number}
            className="flex-1 py-2.5 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-gray-400 text-sm transition-colors"
          >
            ⌫
          </button>
          <button
            onClick={handleDial}
            disabled={dialing || number.replace(/\D/g, '').length < 10}
            className="flex-[2] py-2.5 rounded-lg bg-green-700 hover:bg-green-600 disabled:opacity-40 text-white font-medium text-sm transition-colors"
          >
            {dialing ? 'Dialing…' : '📞 Call'}
          </button>
        </div>

        <p className="text-xs text-gray-600 text-center mt-4">
          Calls are placed from +1 (954) 637-7300 and logged automatically.
        </p>
      </div>
    </div>
  );
}
