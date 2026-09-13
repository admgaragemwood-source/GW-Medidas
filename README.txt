GW Medidas 6.5.0 — Integração GW: Orçamentos → Projetos

- GW Medidas lê clientes, orçamentos e projetos do GW Assistente.
- Orçamento sem projeto aprovado aparece como medição vinculada a ORÇAMENTO.
- Quando o orçamento já gerou um Projeto, aparece somente o Projeto, evitando duplicidade.
- Itens importados removidos no GW Assistente deixam de aparecer após nova sincronização; medições locais são preservadas.
- Somente leitura: esta versão não grava nada no GW Assistente.

GW Medidas 6.2.2 — Parede com largura + altura e voz contínua

- Edição da parede volta a mostrar as duas dimensões essenciais: largura e altura.
- Voz da parede aceita as duas medidas na mesma sessão.
- Altura atualiza a altura do ambiente usada nas vistas, resumo e exportação.
- Mantidos voz contínua dos itens e todos os comportamentos validados da 6.2.1.

GW Medidas 6.0.26 — Coluna/Pilar proporcionais e totalmente internos

- Coluna e Pilar agora usam largura e profundidade reais na escala da planta.
- O bloco fica 100% dentro das quatro linhas do ambiente, inclusive nos cantos.
- Demais recursos da 6.0.25 preservados.

GW Medidas 6.0.25 — correção final Coluna/Pilar na planta
- Coluna e Pilar ficam totalmente dentro do ambiente, encostados na face interna da parede.
- Símbolo técnico compacto, sem caixa de texto sobre a planta.
- Demais recursos do 6.0.24 preservados.

GW Medidas 6.0.21 — Camadas + coluna dentro da planta

- Restaurado Enviar para trás / Trazer para frente na tela Medida.
- Camada visual aplicada na planta e vista frontal.
- Colunas/pilares/estruturas deslocados para dentro do ambiente na planta, evitando ficar metade para fora da parede.
- Mantidos objetos livres, profundidade de rodapé/sanca, gestos e túnel externo.

GW Medidas 6.0.12 — Correção de desseleção no iPhone

Esta versão preserva a base 6.0.11 e altera somente o tratamento do toque em área vazia.

Teste principal:
1. Toque em um item: fica selecionado/azul.
2. Toque em uma área vazia da planta ou parede: deve voltar a NADA SELECIONADO.
3. Com nada selecionado, arraste com 1 dedo: move a tela sem mover objetos.
4. Use 2 dedos: zoom.


GW Medidas 6.0.20 — Correção de renderização no acesso web/túnel
- Correção cirúrgica nos handlers SVG da planta.
- Preservados objetos livres, profundidade de rodapé/sanca, tela Medida e gestos validados.


GW Medidas 6.0.22 — Fechamento da etapa de medição
- Camadas: Enviar para trás / Trazer para frente.
- Estruturas na planta posicionadas para dentro do ambiente.
- Exportação reformulada: planta principal, vistas frontais relevantes, fotos, ficha técnica e notas.
- Vista em Ângulo removida da prévia e do PDF.
