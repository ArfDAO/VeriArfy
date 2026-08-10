import { shortAddress } from "../lib/wallet";

interface NavProps {
  address: string | null;
  onConnect: () => void;
}

export function Nav({ address, onConnect }: NavProps) {
  return (
    <nav className="nav section">
      <div className="nav__brand">
        <div className="nav__dots" aria-hidden>
          <span />
          <span className="off" />
          <span />
          <span className="off" />
          <span />
          <span className="off" />
          <span />
          <span className="off" />
          <span />
        </div>
        <span className="nav__word">veriarfy</span>
      </div>

      <div className="nav__links">
        <a className="nav__link" href="#katil">
          Katil
        </a>
        <a className="nav__link" href="#sonuclar">
          Sonuclar
        </a>
      </div>

      <div className="nav__actions">
        {address ? (
          <span className="tag">{shortAddress(address)}</span>
        ) : (
          <button className="pill pill--ghost" onClick={onConnect}>
            Cuzdan
          </button>
        )}
        <a className="pill pill--primary" href="#katil">
          Katil
        </a>
      </div>
    </nav>
  );
}
