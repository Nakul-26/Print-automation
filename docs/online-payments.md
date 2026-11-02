# Taking online payments (for shop owners)

Students can pay on the website with UPI, cards or net banking. The money goes straight to **your own
Razorpay account and bank**. You do not give the platform any money, and students can still choose to
pay at the counter.

## Set it up (10 minutes)

1. Make an account at [razorpay.com](https://dashboard.razorpay.com/signup). There is no setup fee.
   Razorpay has offered new accounts a 0% fee for their first months; check their pricing page for what
   applies to you today.
2. In the Razorpay dashboard: **Account & Settings → API Keys → Generate Key**. Start with **Test** mode.
3. On your queue page press **Payments**. Paste the **Key ID** (starts `rzp_test_`) and the **Key
   Secret**. Press **Save and connect**. The keys are checked and the secret is stored encrypted.
4. Try it: open your shop's page as a student, add a file, choose **Pay online now**. In test mode use
   Razorpay's test UPI id `success@razorpay` or their test cards. Nobody is charged.
5. When it all works, generate **Live** keys in Razorpay (it asks for your business details) and press
   **Payments → Change keys** to switch. Anything you tried in test mode never touches real money.

## Day to day

- An order paid online shows **Paid online ₹X (UPI) ✓ Nothing to collect.** It only appears in your
  queue after the money has arrived.
- An order paid at the counter shows **Pay at the counter: collect ₹X.** Nothing is asked or recorded.
- **Reject** a paid order and the student is refunded automatically from your Razorpay account
  (the card/UPI refund reaches them in 5 to 7 working days). The reject box tells you this.
- If a refund cannot be sent (for example your Razorpay balance is too low) the order shows a red
  notice: refund it from the Razorpay dashboard. The platform admin sees it too.
- Keep a little balance in Razorpay to cover refunds.
- You can switch **Accept online payments** off at any time; orders already paid are not affected.

## Good to know

- A student has 20 minutes to finish paying. After that the order is cancelled and you never see it.
- A paid order is for exactly the amount paid; you cannot change it when completing the order.
- Orders under ₹1 are always paid at the counter (Razorpay's minimum).
- Your money, settlements and tax records are in your Razorpay dashboard, not in this app.
