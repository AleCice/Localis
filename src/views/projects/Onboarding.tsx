interface OnboardingProps {
  onStart: () => void;
  onSkip: () => void;
}

export function Onboarding({ onStart, onSkip }: OnboardingProps) {
  return (
    <section className="onboarding" aria-labelledby="onboarding-title">
      <h1 id="onboarding-title" className="onboarding-title">
        Benvenuto in Localis
      </h1>
      <p className="onboarding-text">
        Raccogli il tuo lavoro in progetti: un progetto può essere un corso, una tesi o una ricerca.
      </p>
      <div className="onboarding-actions">
        <button type="button" className="btn btn-primary" onClick={onStart}>
          Crea il primo progetto
        </button>
        <button type="button" className="btn btn-ghost" onClick={onSkip}>
          Salta
        </button>
      </div>
    </section>
  );
}
