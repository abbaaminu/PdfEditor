import { useCallback, useEffect, useRef, useState } from 'react';
import { BadgeCheck, Check, CircleAlert, Crown, LoaderCircle, Sparkles, X } from 'lucide-react';
import { useAuthStore } from '../store/auth-context';
import { useToast } from './toast-context';

interface UpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Optional banner text shown above the pricing (e.g. the trial-limit message). */
  message?: string;
}

type BillingCycle = 'monthly' | 'yearly';

/** Minimal structural typing for the Paddle global exposed by the embed script. */
interface PaddleCheckoutOpenOptions {
  items: Array<{ priceId: string; quantity: number }>;
  customer?: { email?: string };
  settings?: Record<string, unknown>;
  /** Attached to the transaction so the Paddle webhook can map it to a user. */
  customData?: Record<string, unknown>;
  successCallback?: () => void;
  eventCallback?: (event: PaddleEvent) => void;
}

interface PaddleCheckout {
  open: (options: PaddleCheckoutOpenOptions) => void;
}

interface PaddleInstance {
  Checkout: PaddleCheckout;
}

interface PaddleEvent {
  name?: string;
  type?: string;
  data?: unknown;
}

const COMPLETED_EVENT = 'checkout.completed';
const CLOSED_EVENT = 'checkout.closed';
const FAILED_EVENTS = new Set(['checkout.error', 'checkout.failed']);

/**
 * Cache the in-flight Paddle SDK initialization so repeated open/close of the
 * modal never stacks duplicate `initializePaddle()` calls or orphaned
 * promises. Cleared when initialization rejects so it can be retried later.
 */
let paddleInitialization: Promise<PaddleInstance | null> | null = null;

function getPriceId(billingCycle: BillingCycle): string {
  const monthly = (import.meta.env.VITE_PADDLE_PRICE_MONTHLY as string | undefined)?.trim();
  const yearly = (import.meta.env.VITE_PADDLE_PRICE_YEARLY as string | undefined)?.trim();
  return billingCycle === 'monthly'
    ? monthly || 'pri_monthly_id_here'
    : yearly || 'pri_yearly_id_here';
}

export const UpgradeModal: React.FC<UpgradeModalProps> = ({ isOpen, onClose, message }) => {
  const { isProUser, setProUser, user } = useAuthStore();
  const toast = useToast();

  const [billingCycle, setBillingCycle] = useState<BillingCycle>('monthly');
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [isDemoCheckout, setIsDemoCheckout] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [promoError, setPromoError] = useState('');

  /** Guards against late callbacks after the modal was closed/cancelled. */
  const sessionActiveRef = useRef(false);
  const demoTimerRef = useRef<number | null>(null);

  // Invalidate any in-flight checkout/demo session whenever the modal closes.
  useEffect(() => {
    if (isOpen) return;
    sessionActiveRef.current = false;
    if (demoTimerRef.current !== null) {
      window.clearTimeout(demoTimerRef.current);
      demoTimerRef.current = null;
    }
  }, [isOpen]);

  // Extra safety: invalidate the session and clear timers on unmount.
  useEffect(() => {
    return () => {
      sessionActiveRef.current = false;
      if (demoTimerRef.current !== null) {
        window.clearTimeout(demoTimerRef.current);
        demoTimerRef.current = null;
      }
    };
  }, []);

  const handleClose = useCallback(() => {
    sessionActiveRef.current = false;
    setIsCheckingOut(false);
    setIsDemoCheckout(false);
    if (demoTimerRef.current !== null) {
      window.clearTimeout(demoTimerRef.current);
      demoTimerRef.current = null;
    }
    onClose();
  }, [onClose]);

  // Close the modal when Escape is pressed while it is open.
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose, isOpen]);

  const handlePurchaseComplete = useCallback(() => {
    if (!sessionActiveRef.current) return; // modal closed / session cancelled
    sessionActiveRef.current = false;
    if (demoTimerRef.current !== null) {
      window.clearTimeout(demoTimerRef.current);
      demoTimerRef.current = null;
    }
    setProUser(true);
    toast.success('Welcome to Pro! All Pro features are now unlocked on this device.');
    handleClose();
  }, [handleClose, setProUser, toast]);

  const applyPromoCode = useCallback(() => {
    const configuredCode = (
      import.meta.env.VITE_PRO_PROMO_CODE || import.meta.env.VITE_PADDLE_PROMO_CODE || ''
    ).trim();
    if (!configuredCode || promoCode.trim().toLowerCase() !== configuredCode.toLowerCase()) {
      setPromoError('That promo code is not valid.');
      return;
    }
    sessionActiveRef.current = true;
    handlePurchaseComplete();
  }, [handlePurchaseComplete, promoCode]);

  const handleCheckoutEvent = useCallback(
    (event: PaddleEvent) => {
      const data = event?.data;
      const nestedType =
        typeof data === 'object' && data !== null
          ? (data as { type?: string }).type
          : undefined;
      const completed =
        event?.type === COMPLETED_EVENT ||
        event?.name === COMPLETED_EVENT ||
        nestedType === COMPLETED_EVENT;
      if (completed) {
        handlePurchaseComplete();
        return;
      }
      const closed = event?.type === CLOSED_EVENT || event?.name === CLOSED_EVENT;
      const failed = FAILED_EVENTS.has(event?.type ?? '') || FAILED_EVENTS.has(event?.name ?? '');
      if (closed || failed) {
        setIsCheckingOut(false);
      }
    },
    [handlePurchaseComplete]
  );

  const startCheckout = useCallback(async () => {
    if (isCheckingOut) return;
    sessionActiveRef.current = true;
    setIsCheckingOut(true);
    setIsDemoCheckout(false);

    try {
      const items = [{ priceId: getPriceId(billingCycle), quantity: 1 }];

      const openCheckout = (): PaddleCheckoutOpenOptions => {
        const options: PaddleCheckoutOpenOptions = {
          items,
          successCallback: handlePurchaseComplete,
          eventCallback: handleCheckoutEvent,
        };
        if (user?.email) options.customer = { email: user.email };
        if (user?.id) {
          options.customData = { user_id: user.id };
        }
        return options;
      };

      // 1. Prefer a global Paddle instance (e.g. classic embed script).
      const globalPaddle = (window as unknown as { Paddle?: PaddleInstance }).Paddle;
      if (globalPaddle?.Checkout?.open) {
        if (!sessionActiveRef.current) return;
        globalPaddle.Checkout.open(openCheckout());
        return;
      }

      // 2. Otherwise initialize the Paddle SDK (deduped) when a client token is set.
      const token = (
        import.meta.env.VITE_PADDLE_CLIENT_TOKEN ||
        import.meta.env.VITE_PADDLE_SELLER_ID ||
        ''
      ).trim();

      if (token) {
        if (!paddleInitialization) {
          paddleInitialization = import('@paddle/paddle-js')
            .then(({ initializePaddle }) => {
              const environment =
                import.meta.env.VITE_PADDLE_ENV === 'production' ? 'production' : 'sandbox';
              return initializePaddle({
                environment,
                token,
                eventCallback: handleCheckoutEvent,
              }) as unknown as PaddleInstance | null;
            })
            .catch((err) => {
              paddleInitialization = null; // allow a later retry
              throw err;
            });
        }
        const instance = await paddleInitialization;
        if (!sessionActiveRef.current || !instance) return;
        instance.Checkout.open(openCheckout());
        return;
      }

      // 3. Development fallback so the upgrade flow can be tested end-to-end.
      if (import.meta.env.DEV) {
        if (!sessionActiveRef.current) return;
        setIsDemoCheckout(true);
        demoTimerRef.current = window.setTimeout(() => {
          demoTimerRef.current = null;
          handlePurchaseComplete();
        }, 700);
        return;
      }

      if (sessionActiveRef.current) {
        toast.error(
          'Paddle is not configured on this device. Please contact support to complete your upgrade.'
        );
      }
    } catch (err) {
      if (sessionActiveRef.current) {
        toast.error(
          err instanceof Error ? err.message : 'Unable to start checkout. Please try again.'
        );
      }
    } finally {
      setIsCheckingOut(false);
    }
  }, [billingCycle, handleCheckoutEvent, handlePurchaseComplete, isCheckingOut, toast, user]);

  if (!isOpen) return null;

  // Already a Pro subscriber: show an active-status screen instead of pricing.
  if (isProUser) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
        onClick={handleClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Pro subscription status"
          className="relative w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 text-center text-slate-100 shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-3"
          >
            <button
              type="button"
              aria-label="Close"
              onClick={(event) => {
                event.stopPropagation();
                handleClose();
              }}
              className="pointer-events-auto relative z-50 cursor-pointer rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          </span>
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
            <BadgeCheck className="h-8 w-8" />
          </div>
          <h3 className="text-2xl font-bold">Pro is Active</h3>
          <p className="mt-2 text-sm text-slate-400">
            Your Pro features are unlocked on this device. Thank you for supporting the app!
          </p>
          <button
            type="button"
            onClick={handleClose}
            className="mt-6 w-full rounded-xl bg-emerald-600 py-3 font-semibold text-white transition hover:bg-emerald-500"
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Upgrade to Pro"
        className="relative w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-3"
        >
          <button
            type="button"
            aria-label="Close"
            onClick={(event) => {
              event.stopPropagation();
              handleClose();
            }}
            className="pointer-events-auto relative z-50 cursor-pointer rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </span>

        <div className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-600/20 text-indigo-400">
            <Crown className="h-6 w-6" />
          </div>
          <h3 className="text-2xl font-bold">Upgrade to Pro</h3>
          <p className="mt-1 text-sm text-slate-400">Unlock unlimited PDF & Document features</p>
        </div>

        {message && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-left text-sm leading-relaxed text-amber-200">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{message}</span>
          </div>
        )}

        {/* Plan Switcher */}
        <div className="mt-6 flex justify-center">
          <div className="flex items-center rounded-lg border border-slate-700 bg-slate-800 p-1">
            <button
              type="button"
              onClick={() => setBillingCycle('monthly')}
              className={`rounded-md px-4 py-1.5 text-xs font-semibold transition ${
                billingCycle === 'monthly'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Monthly ($2/mo)
            </button>
            <button
              type="button"
              onClick={() => setBillingCycle('yearly')}
              className={`rounded-md px-4 py-1.5 text-xs font-semibold transition ${
                billingCycle === 'yearly'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Yearly ($20/yr)
              <span className="ml-1.5 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-400">
                Save 16%
              </span>
            </button>
          </div>
        </div>

        {/* Features List */}
        <ul className="mt-6 space-y-3 text-sm text-slate-300">
          <li className="flex items-center gap-3">
            <Check className="h-4 w-4 shrink-0 text-emerald-400" />
            <span>Batch PDF Compression & Splitting</span>
          </li>
          <li className="flex items-center gap-3">
            <Check className="h-4 w-4 shrink-0 text-emerald-400" />
            <span>Custom Watermark Engine</span>
          </li>
          <li className="flex items-center gap-3">
            <Check className="h-4 w-4 shrink-0 text-emerald-400" />
            <span>Unlimited Word to PDF Conversions</span>
          </li>
          <li className="flex items-center gap-3">
            <Check className="h-4 w-4 shrink-0 text-emerald-400" />
            <span>Images to PDF & high-fidelity exports</span>
          </li>
        </ul>

        <button
          type="button"
          onClick={startCheckout}
          disabled={isCheckingOut}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-3 font-semibold text-white shadow-lg transition hover:bg-indigo-500 active:scale-98 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {isCheckingOut ? (
            <LoaderCircle className="h-5 w-5 animate-spin" />
          ) : (
            <Sparkles className="h-5 w-5" />
          )}
          {isCheckingOut
            ? 'Opening checkout…'
            : `Subscribe for ${billingCycle === 'monthly' ? '$2.00 / month' : '$20.00 / year'}`}
        </button>

        <div className="mt-4 border-t border-slate-800 pt-4">
          <label htmlFor="promo-code" className="block text-xs font-semibold text-slate-400">
            Have a promo code?
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id="promo-code"
              value={promoCode}
              onChange={(event) => {
                setPromoCode(event.target.value);
                setPromoError('');
              }}
              placeholder="Enter code"
              autoComplete="off"
              className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button
              type="button"
              onClick={applyPromoCode}
              disabled={!promoCode.trim() || isCheckingOut}
              className="rounded-lg border border-indigo-500/50 px-3 py-2 text-xs font-semibold text-indigo-300 transition hover:bg-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Apply
            </button>
          </div>
          {promoError && <p className="mt-2 text-xs text-red-300">{promoError}</p>}
        </div>

        {isDemoCheckout && (
          <p className="mt-3 text-center text-xs text-amber-400">
            Demo checkout enabled — no payment is collected in development.
          </p>
        )}
      </div>
    </div>
  );
};