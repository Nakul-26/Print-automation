# Setting up printing at a shop

For whoever installs the printing app on the shop PC (about five minutes).

1. **Install the app** on the computer the printers are connected to (installer file, or the
   Microsoft Store once it is published). Both printers must already work from that computer.
2. On the owner dashboard press **Set up printing → Show a code**. A six-digit code appears (valid
   15 minutes).
3. Open the **printing app** (it opens by itself after installing; later it lives near the clock).
   Type the code and press **Link this PC**.
4. The dashboard switches to **Printing connected ✓** by itself and shows the printers it found.
   Check the black-and-white and colour printers are the right ones (change them if not) and that
   "prints on both sides" is ticked for printers that can.
5. Press **Send test page**. One page comes out of each printer (the colour one has four colour
   bars). If it does, you are done.

From then on the owner only presses **Print** or **Reject**.

## If something is wrong

| What you see                                 | What to do                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Dashboard says the app is offline            | The shop PC is off or the app was closed. Start the app. Waiting orders print when it is back.   |
| "No printer is assigned for colour printing" | Open Printing on the dashboard, choose the printer, Save, then press **Try again** on the order. |
| "…is not set up for 2-sided printing"        | Tick "prints on both sides" for that printer (if it really can), then **Try again**.             |
| "…is offline. Turn it on…"                   | Switch the printer on / check its cable or Wi-Fi, then **Try again**.                            |
| Anything else keeps failing                  | Press **Print by hand**; the PDF is on the order card. Tell us what the message said.            |
| Changing the shop computer                   | Printing → Use a different computer → show a code → type it into the app on the new PC.          |

## For us (before the pilot)

- Install on the real PC and print the test page on both printers.
- Print one two-sided portrait and one two-sided landscape order and check the flip edge (see
  `duplexFor` in `packages/domain/src/printers.ts`; change it if it is the wrong way round).
- Print a colour order and a B&W order and check no colour toner is used for B&W (set the colour
  printer's default to grayscale if it is).
