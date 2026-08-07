"""add chunks table

Revision ID: 1dc88ee6cee5
Revises: 63c3f2386827
Create Date: 2026-08-06 22:24:00.306292

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '1dc88ee6cee5'
down_revision: Union[str, Sequence[str], None] = '63c3f2386827'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Autogenerate also offered to drop classes.voice_name, a column that exists
    # in the database and not in the models. That is drift from somewhere else
    # and it holds data, so it is deliberately not part of this migration.
    op.create_table('chunks',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('session_id', sa.Integer(), nullable=False),
    sa.Column('idx', sa.Integer(), nullable=False),
    sa.Column('text', sa.Text(), nullable=False),
    sa.Column('words_json', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], name=op.f('fk_chunks_session_id_sessions'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_chunks'))
    )
    with op.batch_alter_table('chunks', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_chunks_session_id'), ['session_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('chunks', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_chunks_session_id'))

    op.drop_table('chunks')
    # ### end Alembic commands ###
