export type OrderStatus =
  | 'draft'
  | 'processing'
  | 'pending'
  | 'accepted'
  | 'printing'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'expired';

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ['processing'],
  processing: ['pending', 'failed'],
  pending: ['accepted', 'printing', 'rejected', 'expired'],
  accepted: ['printing', 'completed', 'rejected', 'expired'],
  printing: ['completed', 'accepted', 'expired'],
  completed: [],
  rejected: [],
  failed: [],
  expired: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
