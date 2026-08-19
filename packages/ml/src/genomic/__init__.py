"""VeriArfy genomik cikarim paketi.

# CONCRETE IMPORT SIRASI BURADA SABITLENIR — DEGISTIRMEYIN

`concrete.ml.sklearn`, `concrete.ml.deployment`'tan **once** yuklenmelidir.
Ters sirada Concrete'in yerel/LLVM baslatmasi bozuluyor ve derleme, devre
belli bir karmasikligi asinca surec olumuyle (SIGABRT, "Pure virtual function
called") duşuyor. Python istisnasi olmadigi icin `try/except` ile yakalanamaz.

Bu, aylarca "panel >= 20'de LLVM cokuyor" diye yanlis teshis edildi ve panel
tavani 16'ya sabitlendi. Gercek sebep import sirasiydi; duzeltilince ayni
veriyle 3892 varyantin tamami derlendi (bkz. `docs/mimari/0011-panel-tavani.md`).

Sirayi her modulde tek tek dogru yazmaya guvenmek kirilgandi: `model.py`
duzeltildikten sonra `server.py` ayni hatayi tasimaya devam etti. Bu yuzden
garanti PAKET GIRISINE tasindi — `src.genomic` altindaki herhangi bir modul
ithal edildiginde Python once burayi calistirir ve dogru sira kurulmus olur.
"""

# Bu satirin tek gorevi sirayi kurmak; sembol disari verilmez.
import concrete.ml.sklearn as _concrete_sklearn_first  # noqa: F401
