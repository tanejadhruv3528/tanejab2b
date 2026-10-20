import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Onboarding as OnboardingData } from '../api';
import { useI18n } from '../i18n';

const LICENSE_TYPES = ['form_20', 'form_21', 'form_20_21', 'form_20b', 'form_21b', 'other'] as const;
const LICENSE_LABELS: Record<string, string> = {
  form_20: 'Form 20',
  form_21: 'Form 21',
  form_20_21: 'Form 20 + 21',
  form_20b: 'Form 20B',
  form_21b: 'Form 21B',
  other: 'Other',
};
const UPLOAD_KINDS = ['drug_license', 'store_photo', 'gst_certificate'] as const;
const EDITABLE = new Set(['draft', 'needs_resubmission']);

interface Form {
  businessName: string;
  ownerName: string;
  email: string;
  gstin: string;
  addressLine1: string;
  landmark: string;
  city: string;
  district: string;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
  licenseType: string;
  licenseNumber: string;
  validUntil: string;
}

const EMPTY: Form = {
  businessName: '',
  ownerName: '',
  email: '',
  gstin: '',
  addressLine1: '',
  landmark: '',
  city: 'Samastipur',
  district: 'Samastipur',
  postalCode: '',
  latitude: null,
  longitude: null,
  licenseType: 'form_20_21',
  licenseNumber: '',
  validUntil: '',
};

function toForm(d: OnboardingData): Form {
  return {
    businessName: d.account?.businessName ?? '',
    ownerName: d.account?.ownerName ?? '',
    email: d.account?.email ?? '',
    gstin: d.account?.gstin ?? '',
    addressLine1: d.store?.addressLine1 ?? '',
    landmark: d.store?.landmark ?? '',
    city: d.store?.city ?? EMPTY.city,
    district: d.store?.district ?? EMPTY.district,
    postalCode: d.store?.postalCode ?? '',
    latitude: d.store?.latitude ?? null,
    longitude: d.store?.longitude ?? null,
    licenseType: d.license?.type ?? EMPTY.licenseType,
    licenseNumber: d.license?.number ?? '',
    validUntil: d.license?.validUntil ?? '',
  };
}

export function Onboarding({ onApproved }: { onApproved: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<OnboardingData | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const d = await api<OnboardingData>('GET', '/retailer/onboarding');
    setData(d);
    if (d.account) setForm(toForm(d));
    if (d.account?.status === 'approved') onApproved();
  };

  useEffect(() => {
    void load().catch(() => setMessage(t('genericError')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status = data?.account?.status ?? 'draft';
  const editable = EDITABLE.has(status);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function run(fn: () => Promise<void>, success?: string) {
    setBusy(true);
    setMessage(null);
    setErrors({});
    try {
      await fn();
      if (success) setMessage(success);
    } catch (e) {
      if (e instanceof ApiError) {
        setMessage(e.message);
        if (e.details) setErrors(e.details);
      } else setMessage(t('genericError'));
    } finally {
      setBusy(false);
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {
      businessName: form.businessName.trim(),
      ownerName: form.ownerName.trim(),
      email: form.email.trim() || null,
      gstin: form.gstin.trim().toUpperCase() || null,
    };
    if (form.addressLine1.trim() && form.latitude != null && form.longitude != null) {
      body.store = {
        addressLine1: form.addressLine1.trim(),
        landmark: form.landmark.trim() || null,
        city: form.city.trim(),
        district: form.district.trim(),
        postalCode: form.postalCode.trim(),
        latitude: form.latitude,
        longitude: form.longitude,
      };
    }
    if (form.licenseNumber.trim() && form.validUntil) {
      body.license = { type: form.licenseType, number: form.licenseNumber.trim(), validUntil: form.validUntil };
    }
    void run(async () => {
      await api('PUT', '/retailer/onboarding', body);
      await load();
    }, t('saved'));
  };

  const locate = () => {
    if (!navigator.geolocation) return setMessage(t('locationFailed'));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        set('latitude', Number(pos.coords.latitude.toFixed(6)));
        set('longitude', Number(pos.coords.longitude.toFixed(6)));
      },
      () => setMessage(t('locationFailed')),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const upload = (kind: string, file: File) =>
    run(async () => {
      await api('POST', `/retailer/kyc/documents/${kind}`, file);
      await load();
    }, t('uploaded'));

  const submit = () =>
    run(async () => {
      await api('POST', '/retailer/kyc/submit');
      await load();
    });

  const uploadedKinds = new Set(data?.documents?.map((d) => d.kind));
  const field = (key: keyof Form, label: string, props: Record<string, unknown> = {}) => (
    <label>
      {t(label)}
      <input
        value={String(form[key] ?? '')}
        onChange={(e) => set(key, e.target.value as never)}
        disabled={!editable}
        {...props}
      />
      {errors[key] && <span className="error small">{errors[key]}</span>}
    </label>
  );

  return (
    <main className="screen">
      <h2>{t('registerTitle')}</h2>
      <p className={`status ${status}`}>{t(`status_${status}`)}</p>
      {data?.latestDecision?.reason && status === 'needs_resubmission' && (
        <p className="error">{data.latestDecision.reason}</p>
      )}

      <form onSubmit={save} className="card">
        {field('businessName', 'businessName', { required: true, maxLength: 200 })}
        {field('ownerName', 'ownerName', { required: true, maxLength: 120 })}
        {field('email', 'email', { type: 'email', maxLength: 200 })}
        {field('gstin', 'gstin', { maxLength: 15 })}

        <h3>{t('storeAddress')}</h3>
        {field('addressLine1', 'addressLine1', { maxLength: 300 })}
        {field('landmark', 'landmark', { maxLength: 200 })}
        {field('city', 'city', { maxLength: 100 })}
        {field('district', 'district', { maxLength: 100 })}
        {field('postalCode', 'postalCode', { inputMode: 'numeric', maxLength: 6, pattern: '[1-9][0-9]{5}' })}
        <div>
          <span>{t('location')}</span>
          {form.latitude != null ? (
            <p className="small">
              {t('locationSet')}: {form.latitude}, {form.longitude}
            </p>
          ) : null}
          {editable && (
            <button type="button" className="secondary" onClick={locate}>
              {t('useLocation')}
            </button>
          )}
          {errors['store.location'] && <span className="error small">{errors['store.location']}</span>}
        </div>

        <h3>{t('license')}</h3>
        <label>
          {t('licenseType')}
          <select value={form.licenseType} onChange={(e) => set('licenseType', e.target.value)} disabled={!editable}>
            {LICENSE_TYPES.map((type) => (
              <option key={type} value={type}>
                {LICENSE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        {field('licenseNumber', 'licenseNumber', { maxLength: 100 })}
        {field('validUntil', 'validUntil', { type: 'date' })}

        {editable && (
          <button type="submit" disabled={busy}>
            {t('save')}
          </button>
        )}
      </form>

      {data?.account && (
        <div className="card">
          <h3>{t('documents')}</h3>
          {UPLOAD_KINDS.map((kind) => (
            <label key={kind} className="upload">
              <span>
                {t(kind)} {uploadedKinds.has(kind) && <span className="badge in_stock">{t('uploaded')}</span>}
              </span>
              {editable && (
                <input
                  type="file"
                  accept="image/jpeg,image/png,application/pdf"
                  aria-label={`${t('upload')} ${t(kind)}`}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void upload(kind, file);
                    e.target.value = '';
                  }}
                />
              )}
            </label>
          ))}
        </div>
      )}

      {editable && data?.account && (
        <div className="card">
          {data.gaps && data.gaps.length > 0 ? (
            <>
              <p>{t('stillNeeded')}:</p>
              <ul>
                {data.gaps.map((g) => (
                  <li key={g}>{t(g)}</li>
                ))}
              </ul>
            </>
          ) : null}
          <button type="button" disabled={busy || (data.gaps?.length ?? 0) > 0} onClick={() => void submit()}>
            {t('submit')}
          </button>
        </div>
      )}
      {!editable && status !== 'approved' && (
        <button type="button" className="secondary" onClick={() => void load()}>
          {t('refresh')}
        </button>
      )}
      {message && <p role="status">{message}</p>}
    </main>
  );
}
