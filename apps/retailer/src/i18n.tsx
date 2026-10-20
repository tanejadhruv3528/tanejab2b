import { createContext, useContext, useState, type ReactNode } from 'react';

export type Lang = 'en' | 'hi';

// Hindi strings are a first draft and need review by a native speaker before the pilot.
const strings = {
  appName: { en: 'Taneja Drug Agency', hi: 'तनेजा ड्रग एजेंसी' },
  tagline: { en: 'Wholesale ordering for approved pharmacies', hi: 'स्वीकृत फ़ार्मेसियों के लिए थोक ऑर्डर' },
  phone: { en: 'Mobile number', hi: 'मोबाइल नंबर' },
  sendOtp: { en: 'Send OTP', hi: 'OTP भेजें' },
  otp: { en: 'OTP', hi: 'OTP' },
  otpSentTo: { en: 'OTP sent to', hi: 'OTP भेजा गया' },
  verify: { en: 'Verify and log in', hi: 'सत्यापित करें और लॉग इन करें' },
  changeNumber: { en: 'Change number', hi: 'नंबर बदलें' },
  logout: { en: 'Log out', hi: 'लॉग आउट' },
  search: { en: 'Search', hi: 'खोजें' },
  searchPlaceholder: { en: 'Medicine, salt or company', hi: 'दवा, साल्ट या कंपनी' },
  cart: { en: 'Cart', hi: 'कार्ट' },
  add: { en: 'Add', hi: 'जोड़ें' },
  remove: { en: 'Remove', hi: 'हटाएँ' },
  noResults: { en: 'No medicines found', hi: 'कोई दवा नहीं मिली' },
  mrp: { en: 'MRP', hi: 'MRP' },
  in_stock: { en: 'In stock', hi: 'स्टॉक में' },
  low_stock: { en: 'Low stock', hi: 'कम स्टॉक' },
  out_of_stock: { en: 'Out of stock', hi: 'स्टॉक में नहीं' },
  restricted: { en: 'Not orderable', hi: 'ऑर्डर नहीं हो सकता' },
  discontinued: { en: 'Discontinued', hi: 'बंद' },
  stale: { en: 'Stock may be outdated', hi: 'स्टॉक जानकारी पुरानी हो सकती है' },
  coldChain: { en: 'Cold chain', hi: 'कोल्ड चेन' },
  emptyCart: { en: 'Your cart is empty', hi: 'आपका कार्ट खाली है' },
  subtotal: { en: 'Subtotal', hi: 'उप-योग' },
  discount: { en: 'Discount', hi: 'छूट' },
  gst: { en: 'GST', hi: 'GST' },
  delivery: { en: 'Delivery', hi: 'डिलीवरी' },
  payable: { en: 'Total payable', hi: 'कुल देय' },
  checkout: { en: 'Checkout', hi: 'चेकआउट' },
  codAvailable: { en: 'Cash on delivery available', hi: 'कैश ऑन डिलीवरी उपलब्ध' },
  prepaidOnly: { en: 'Online payment only for this order', hi: 'इस ऑर्डर के लिए केवल ऑनलाइन भुगतान' },
  noPaymentMethod: { en: 'Cash on delivery is not available for this order and online payment is not live yet. Reduce the order or contact Taneja Drug Agency.', hi: 'इस ऑर्डर के लिए कैश ऑन डिलीवरी उपलब्ध नहीं है और ऑनलाइन भुगतान अभी शुरू नहीं हुआ है। ऑर्डर कम करें या तनेजा ड्रग एजेंसी से संपर्क करें।' },
  clearCart: { en: 'Clear cart', hi: 'कार्ट खाली करें' },
  qty: { en: 'Qty', hi: 'मात्रा' },
  // Line issues
  DISCONTINUED: { en: 'Discontinued. Please remove.', hi: 'बंद हो गया है। कृपया हटाएँ।' },
  RESTRICTED: { en: 'Cannot be ordered online. Please remove.', hi: 'ऑनलाइन ऑर्डर नहीं हो सकता। कृपया हटाएँ।' },
  COLD_CHAIN_NOT_ENABLED: { en: 'Cold-chain delivery is not available yet.', hi: 'कोल्ड-चेन डिलीवरी अभी उपलब्ध नहीं है।' },
  OUT_OF_STOCK: { en: 'Out of stock. Please remove.', hi: 'स्टॉक में नहीं। कृपया हटाएँ।' },
  INSUFFICIENT_STOCK: { en: 'Only {n} available. Reduce quantity.', hi: 'केवल {n} उपलब्ध। मात्रा घटाएँ।' },
  PRICE_MISSING: { en: 'Price not available yet.', hi: 'कीमत अभी उपलब्ध नहीं है।' },
  TAX_RATE_MISSING: { en: 'Price not available yet.', hi: 'कीमत अभी उपलब्ध नहीं है।' },
  // Order blockers
  EMPTY_CART: { en: 'Add medicines to continue.', hi: 'जारी रखने के लिए दवाएँ जोड़ें।' },
  BELOW_MINIMUM_ORDER: { en: 'Minimum order is {min} before GST and delivery.', hi: 'न्यूनतम ऑर्डर {min} है (GST और डिलीवरी से पहले)।' },
  STORE_NOT_VERIFIED: { en: 'Your store address is not verified yet.', hi: 'आपके स्टोर का पता अभी सत्यापित नहीं है।' },
  RETAILER_NOT_APPROVED: { en: 'Your account is not approved.', hi: 'आपका खाता स्वीकृत नहीं है।' },
  COD_ABOVE_LIMIT: { en: 'Cash on delivery is only up to ₹10,000.', hi: 'कैश ऑन डिलीवरी केवल ₹10,000 तक।' },
  COD_OUTSIDE_SERVICE_ZONE: { en: 'Cash on delivery is not available in your area yet.', hi: 'आपके क्षेत्र में अभी कैश ऑन डिलीवरी नहीं है।' },
  COD_DISABLED_BY_ADMIN: { en: 'Cash on delivery is not enabled for your account.', hi: 'आपके खाते के लिए कैश ऑन डिलीवरी चालू नहीं है।' },
  fixLines: { en: 'Fix the highlighted items to continue.', hi: 'जारी रखने के लिए चिह्नित आइटम ठीक करें।' },
  // Onboarding
  registerTitle: { en: 'Register your pharmacy', hi: 'अपनी फ़ार्मेसी पंजीकृत करें' },
  businessName: { en: 'Pharmacy name', hi: 'फ़ार्मेसी का नाम' },
  ownerName: { en: 'Owner name', hi: 'मालिक का नाम' },
  email: { en: 'Email (optional)', hi: 'ईमेल (वैकल्पिक)' },
  gstin: { en: 'GSTIN (optional)', hi: 'GSTIN (वैकल्पिक)' },
  storeAddress: { en: 'Store address', hi: 'स्टोर का पता' },
  addressLine1: { en: 'Shop number and street', hi: 'दुकान नंबर और गली' },
  landmark: { en: 'Landmark', hi: 'लैंडमार्क' },
  city: { en: 'City / town', hi: 'शहर / कस्बा' },
  district: { en: 'District', hi: 'ज़िला' },
  postalCode: { en: 'PIN code', hi: 'पिन कोड' },
  location: { en: 'Store location', hi: 'स्टोर की लोकेशन' },
  useLocation: { en: 'Use my current location (stand inside the shop)', hi: 'मेरी वर्तमान लोकेशन लें (दुकान के अंदर खड़े होकर)' },
  locationSet: { en: 'Location captured', hi: 'लोकेशन ली गई' },
  locationFailed: { en: 'Could not get location. Allow location access and try again.', hi: 'लोकेशन नहीं मिली। अनुमति दें और फिर कोशिश करें।' },
  license: { en: 'Drug licence', hi: 'ड्रग लाइसेंस' },
  licenseType: { en: 'Licence form', hi: 'लाइसेंस फ़ॉर्म' },
  licenseNumber: { en: 'Licence number', hi: 'लाइसेंस नंबर' },
  validUntil: { en: 'Valid until', hi: 'वैध तिथि' },
  save: { en: 'Save details', hi: 'विवरण सहेजें' },
  saved: { en: 'Saved', hi: 'सहेजा गया' },
  documents: { en: 'Documents', hi: 'दस्तावेज़' },
  drug_license: { en: 'Drug licence photo/PDF', hi: 'ड्रग लाइसेंस फ़ोटो/PDF' },
  store_photo: { en: 'Store front photo', hi: 'दुकान के सामने की फ़ोटो' },
  gst_certificate: { en: 'GST certificate (optional)', hi: 'GST प्रमाणपत्र (वैकल्पिक)' },
  uploaded: { en: 'Uploaded', hi: 'अपलोड हुआ' },
  upload: { en: 'Upload', hi: 'अपलोड करें' },
  submit: { en: 'Submit for verification', hi: 'सत्यापन के लिए जमा करें' },
  stillNeeded: { en: 'Still needed', hi: 'अभी बाकी' },
  status_draft: { en: 'Not submitted yet', hi: 'अभी जमा नहीं किया' },
  status_submitted: { en: 'Submitted. Our team will verify your details and visit your store.', hi: 'जमा हो गया। हमारी टीम आपके विवरण सत्यापित करेगी और स्टोर पर आएगी।' },
  status_under_review: { en: 'Under review', hi: 'समीक्षा में' },
  status_needs_resubmission: { en: 'Changes needed', hi: 'बदलाव ज़रूरी' },
  status_approved: { en: 'Approved', hi: 'स्वीकृत' },
  status_rejected: { en: 'Not approved', hi: 'स्वीकृत नहीं' },
  status_suspended: { en: 'Account suspended. Please contact Taneja Drug Agency.', hi: 'खाता निलंबित। कृपया तनेजा ड्रग एजेंसी से संपर्क करें।' },
  refresh: { en: 'Check status', hi: 'स्थिति देखें' },
  BUSINESS_NAME_MISSING: { en: 'Pharmacy name', hi: 'फ़ार्मेसी का नाम' },
  OWNER_NAME_MISSING: { en: 'Owner name', hi: 'मालिक का नाम' },
  STORE_ADDRESS_MISSING: { en: 'Store address', hi: 'स्टोर का पता' },
  STORE_LOCATION_MISSING: { en: 'Store location', hi: 'स्टोर की लोकेशन' },
  LICENSE_MISSING: { en: 'Drug licence details', hi: 'ड्रग लाइसेंस विवरण' },
  LICENSE_EXPIRED: { en: 'Drug licence has expired', hi: 'ड्रग लाइसेंस की अवधि समाप्त' },
  LICENSE_DOCUMENT_MISSING: { en: 'Drug licence upload', hi: 'ड्रग लाइसेंस अपलोड' },
  STORE_PHOTO_MISSING: { en: 'Store photo', hi: 'स्टोर फ़ोटो' },
  orders: { en: 'Orders', hi: 'ऑर्डर' },
  paymentMethod: { en: 'Payment', hi: 'भुगतान' },
  cod: { en: 'Cash on delivery', hi: 'कैश ऑन डिलीवरी' },
  prepaid: { en: 'Pay online', hi: 'ऑनलाइन भुगतान' },
  placeOrder: { en: 'Place order', hi: 'ऑर्डर करें' },
  placing: { en: 'Placing order…', hi: 'ऑर्डर हो रहा है…' },
  orderPlaced: { en: 'Order {n} placed', hi: 'ऑर्डर {n} हो गया' },
  noOrders: { en: 'No orders yet', hi: 'अभी कोई ऑर्डर नहीं' },
  back: { en: 'Back', hi: 'वापस' },
  items: { en: '{n} items', hi: '{n} आइटम' },
  cancelOrder: { en: 'Cancel order', hi: 'ऑर्डर रद्द करें' },
  requestCancel: { en: 'Request cancellation', hi: 'रद्द करने का अनुरोध करें' },
  confirmCancel: { en: 'Cancel this order?', hi: 'यह ऑर्डर रद्द करें?' },
  awaitingPaymentNote: { en: 'Waiting for payment confirmation from the payment provider.', hi: 'भुगतान प्रदाता से पुष्टि की प्रतीक्षा है।' },
  history: { en: 'History', hi: 'इतिहास' },
  QUOTE_EXPIRED: { en: 'Prices expired. Please check the cart and try again.', hi: 'कीमतें पुरानी हो गईं। कृपया कार्ट देखकर फिर कोशिश करें।' },
  QUOTE_CHANGED: { en: 'Prices or stock changed. Please check the cart and try again.', hi: 'कीमत या स्टॉक बदल गया। कृपया कार्ट देखकर फिर कोशिश करें।' },
  ORDER_INSUFFICIENT_STOCK: { en: 'An item just went out of stock. Please check the cart.', hi: 'एक आइटम अभी स्टॉक से बाहर हो गया। कृपया कार्ट देखें।' },
  PAYMENT_UNAVAILABLE: { en: 'Online payment is not available yet. Please choose cash on delivery.', hi: 'ऑनलाइन भुगतान अभी उपलब्ध नहीं है। कृपया कैश ऑन डिलीवरी चुनें।' },
  PAYMENT_METHOD_NOT_ALLOWED: { en: 'This payment method is not available for this order.', hi: 'इस ऑर्डर के लिए यह भुगतान तरीका उपलब्ध नहीं है।' },
  st_placed: { en: 'Placed', hi: 'ऑर्डर हुआ' },
  st_accepted: { en: 'Accepted', hi: 'स्वीकार' },
  st_picking: { en: 'Being packed', hi: 'पैक हो रहा है' },
  st_short_pick_review: { en: 'Being checked', hi: 'जाँच हो रही है' },
  st_packed: { en: 'Packed', hi: 'पैक हुआ' },
  st_ready_for_dispatch: { en: 'Ready to dispatch', hi: 'भेजने के लिए तैयार' },
  st_assigned_to_rider: { en: 'Rider assigned', hi: 'राइडर तय' },
  st_out_for_delivery: { en: 'Out for delivery', hi: 'डिलीवरी के लिए निकला' },
  st_delivered: { en: 'Delivered', hi: 'डिलीवर हुआ' },
  st_cancel_requested: { en: 'Cancellation requested', hi: 'रद्द करने का अनुरोध' },
  st_cancelled: { en: 'Cancelled', hi: 'रद्द' },
  st_delivery_failed: { en: 'Delivery failed', hi: 'डिलीवरी नहीं हुई' },
  st_returned: { en: 'Returned', hi: 'वापस' },
  st_closed: { en: 'Closed', hi: 'बंद' },
  pay_awaiting_payment: { en: 'Awaiting payment', hi: 'भुगतान बाकी' },
  pay_paid: { en: 'Paid', hi: 'भुगतान हुआ' },
  pay_payment_failed: { en: 'Payment failed', hi: 'भुगतान विफल' },
  pay_cod_due: { en: 'Pay cash on delivery', hi: 'डिलीवरी पर नकद भुगतान' },
  pay_cod_collected: { en: 'Cash collected', hi: 'नकद प्राप्त' },
  pay_refund_pending: { en: 'Refund pending', hi: 'रिफंड बाकी' },
  pay_not_charged: { en: 'Not charged', hi: 'कोई शुल्क नहीं' },
  genericError: { en: 'Something went wrong. Please try again.', hi: 'कुछ गलत हुआ। कृपया फिर कोशिश करें।' },
} satisfies Record<string, Record<Lang, string>>;

export type StringKey = keyof typeof strings;

export function translate(lang: Lang, key: string, vars: Record<string, string | number> = {}): string {
  const entry = (strings as Record<string, Record<Lang, string>>)[key];
  const text = entry ? entry[lang] : key;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

const LANG_KEY = 'taneja.lang';
const I18n = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: typeof translate extends (l: Lang, ...rest: infer R) => string ? (...args: R) => string : never }>(
  null as never,
);

function initialLang(): Lang {
  try {
    return localStorage.getItem(LANG_KEY) === 'hi' ? 'hi' : 'en';
  } catch {
    return 'en';
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      // ignore
    }
  };
  return (
    <I18n.Provider value={{ lang, setLang, t: (key, vars) => translate(lang, key, vars) }}>{children}</I18n.Provider>
  );
}

export const useI18n = () => useContext(I18n);
