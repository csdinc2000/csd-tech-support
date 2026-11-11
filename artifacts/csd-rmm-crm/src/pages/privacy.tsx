import { Link } from "wouter";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-40 w-full border-b border-gray-200 bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/75">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" aria-label="Computer Systems Depot home">
              <img src={csdLogo} alt="Computer Systems Depot" className="h-9 w-auto" />
            </Link>
          </div>
          <nav className="hidden items-center gap-6 text-sm font-medium text-gray-600 lg:flex" aria-label="Main navigation">
            <a href="/#services" className="hover:text-csd-red">Services</a>
            <a href="/#repairs" className="hover:text-csd-red">Repairs</a>
            <a href="/#remote" className="hover:text-csd-red">Remote Support</a>
            <a href="/#company" className="hover:text-csd-red">Company</a>
            <a href="/#contact" className="hover:text-csd-red">Contact</a>
            <Link href="/portal" className="hover:text-csd-red">Client Portal</Link>
          </nav>
          <Link href="/intake" className="shrink-0">
            <span className="inline-flex h-9 items-center rounded-md bg-csd-red px-3 text-sm font-semibold text-white transition-colors hover:bg-red-700">
              Start a Request
            </span>
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <div className="space-y-3 text-center">
          <h1 className="text-2xl font-bold text-gray-900">Privacy Policy</h1>
        </div>

        <div className="bg-white rounded-lg border p-6 space-y-6 text-sm text-gray-700 leading-relaxed">
          <section className="space-y-2">
            <p>
              Computer Systems Depot Inc. ("we", "us", "our") respects your
              privacy. This policy explains what information we collect, how we
              use it, and how we handle SMS text messaging.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-gray-900">
              Information We Collect
            </h2>
            <p>
              When you submit our service intake form, we collect the
              information you provide, such as your name, phone number, email
              address, mailing address, device details, and a description of
              your computer issue. We use this information only to respond to
              your request and provide support and service.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-gray-900">
              SMS Text Messaging
            </h2>
            <p>
              If you opt in, we will send you SMS text messages from Computer
              Systems Depot Inc. for support and service updates. Opting in to
              SMS is optional and is not required to receive service. You can
              opt in by checking the consent box on our intake form or by
              texting us at{" "}
              <a href="sms:+19546377300" className="text-primary underline">
                954-637-7300
              </a>
              .
            </p>
            <p>
              Message frequency varies. Message and data rates may apply. You
              can opt out at any time by replying <strong>STOP</strong> to any
              message. Reply <strong>HELP</strong> for help, or contact us at
              the number below.
            </p>
            <p>
              We do not share your mobile information or SMS consent with third
              parties or affiliates for marketing purposes. Mobile opt-in data
              is never sold or shared with anyone for promotional reasons.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-gray-900">
              How We Use Your Information
            </h2>
            <p>
              We use the information you provide to contact you about your
              service request, schedule and perform repairs, send support and
              service updates, and keep records of the work we do for you. We do
              not sell your personal information.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-gray-900">
              How We Protect Your Information
            </h2>
            <p>
              Computer Systems Depot uses reasonable administrative, technical,
              and physical safeguards to protect customer information. Access is
              limited to authorized personnel and service purposes. Remote
              monitoring and remote access are performed only on authorized
              devices with your consent or under an active service agreement,
              and support calls may be recorded for quality and documentation
              where permitted and with required consent.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-gray-900">Contact Us</h2>
            <p>
              Computer Systems Depot Inc.
              <br />
              5601 NW 13 Street, Lauderhill, Florida 33313
              <br />
              Phone:{" "}
              <a href="tel:954-637-7300" className="text-primary underline">
                954-637-7300
              </a>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
