import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import CsdIntakeForm from "@/components/forms/csd-intake-form";
import { ReferralBanner } from "@/components/referrals/referral-banner";
import csdLogo from "@assets/cropped-CSD-Logo-New_2_1765066834661.png";

export default function CsdIntakePage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-red-600"
          data-testid="link-back-home"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Home
        </Link>
        <div className="text-center space-y-4">
          <img 
            src={csdLogo} 
            alt="Computer Systems Depot" 
            className="h-16 mx-auto"
          />
          <div>
            <p className="text-lg text-gray-600">
              Professional Computer Repair Services in South Florida
            </p>
            <p className="text-sm text-gray-500 mt-2">
              Fill out the form below and we'll contact you soon to help with your computer issue.
            </p>
          </div>
        </div>

        <ReferralBanner />
        <CsdIntakeForm className="max-w-2xl mx-auto" />
        
        <div className="text-center text-sm text-gray-500 space-y-2 pb-8">
          <p>Need immediate assistance?</p>
          <a href="tel:954-637-7300" className="block">
            <p className="font-bold text-red-600 text-2xl hover:text-red-700">954-637-7300</p>
            <p className="text-red-600 font-semibold">Call Now!!!</p>
          </a>
          <div className="mt-4 space-y-1">
            <p className="font-medium text-gray-700">Business Hours</p>
            <p>Monday - Friday: 5:00 AM - 11:00 PM</p>
          </div>
          <div className="mt-4 space-y-1">
            <p className="font-medium text-gray-700">Location</p>
            <p>5601 NW 13 Street</p>
            <p>Lauderhill, Florida 33313</p>
          </div>
          <p className="mt-4 text-xs text-gray-400">
            Serving Broward, Dade & Palm Beach Counties since 1996
          </p>
        </div>
      </div>
    </div>
  );
}